import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { authorTag } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import { afterEach } from 'vitest'
import { Budget } from '../src/budget.ts'
import type { TokenUse } from '../src/budget-credits.ts'
import { Clef, type ClefError, workersClef } from '../src/decisions/client.ts'
import { makeDecisions } from '../src/decisions/live.ts'
import type { Packet } from '../src/decisions/wire.ts'
import { Decisions } from '../src/decisions/service.ts'
import { BudgetExhausted, ResidentInactive } from '../src/http/errors.ts'
import { Resident } from '../src/mcp/service.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { conversationId, entryId } from '../src/pi/context.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import type { TranscriptSource } from '../src/retrieval/index.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { Db } from '../src/runtime/db.ts'
import type { AuxCall } from '../src/telemetry/report.ts'
import { chatDatabase } from './chats-sqlite.ts'

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** A Pi entry of `session`: the owner's input (or an authored one), or an answer with one text block. */
export function entry(
  id: number,
  session: string,
  kind: 'pi.user' | 'pi.assistant',
  text: string,
  author?: string,
): EntryRecord {
  const timestamp = 1_700_000_000_000 + id
  const message: Message =
    kind === 'pi.assistant'
      ? {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'fixture',
          model: 'fixture',
          content: [{ type: 'text', text }],
          usage: { ...usage, cost },
          stopReason: 'stop',
          timestamp,
        }
      : author === undefined
        ? { role: 'user', content: text, timestamp }
        : {
            role: 'user',
            content: [
              { type: 'text', text: authorTag(author) },
              { type: 'text', text },
            ],
            timestamp,
          }
  return { id: entryId(id), conversationId: conversationId(session), kind, model: [message] }
}

/** How the fake Clef answers a packet: each question's probabilities, and the usage it reports. */
export type ClefAnswer = (packet: Packet) => Effect.Effect<unknown, ClefError>

/** Clef answering `probability(question, option)` for every offered option, reporting `input` tokens. */
export const answering =
  (probability: (question: string, option: string) => number, input = 1000): ClefAnswer =>
  (packet) =>
    Effect.succeed({
      usage: { input_tokens: input, output_tokens: 0 },
      answers: Object.fromEntries(
        Object.entries(packet.questions).map(([name, question]) => [
          name,
          { probabilities: Object.fromEntries(question.options.map((option) => [option, probability(name, option)])) },
        ]),
      ),
    })

const opened: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of opened.splice(0)) await close()
})

/** The switches a test sets: how Clef answers and what it sees meanwhile, the budget and resident authority. */
type Switches = {
  answer: ClefAnswer
  calls: number
  exhausted: boolean
  inactive: boolean
  /** Runs inside each Clef call, before it answers: what the world does meanwhile. */
  during: () => void
}

/** What the fixture keeps of what the decisions did: charges, aux records, flows and the change bus's notices. */
type Kept = {
  readonly charged: { readonly use: TokenUse; readonly model: string | undefined }[]
  readonly reported: AuxCall[]
  readonly flows: FlowEvent[]
  readonly changed: string[]
}

/** Pi's sessions as `histories` (each oldest first): the transcript index's source, and each conversation's entries. */
function pi(histories: Readonly<Record<string, readonly EntryRecord[]>>) {
  const newestFirst = (session: string) => (histories[session] ?? []).toSorted((a, b) => b.id - a.id)
  const transcripts: TranscriptSource = {
    newest: async (session) => newestFirst(session)[0]?.id,
    entries: async (session, from, to) => newestFirst(session).filter((each) => each.id >= from && each.id <= to),
    recent: async (session, limit) => newestFirst(session).slice(0, limit),
  }
  const sessions = Layer.mock(PiSessions)({
    // SAFETY: the decisions read only a conversation's `entries`, which this fixture answers.
    conversation: (session) =>
      Effect.succeed(Option.some({ entries: async () => ({ items: newestFirst(session), next: undefined }) } as never)),
  })
  return { transcripts, sessions }
}

/** Clef answering through `state`, or none bound. */
const fakeClef = (state: Switches, unbound: boolean) =>
  unbound
    ? workersClef(undefined)
    : Clef.of({
        available: true,
        evaluate: (packet) =>
          Effect.suspend(() => {
            state.calls += 1
            state.during()
            return state.answer(packet)
          }),
      })

/** The daily budget and resident authority as `state` switches them, each charge kept. */
const authority = (state: Switches, kept: Kept) =>
  Layer.mergeAll(
    Layer.mock(Budget)({
      record: (use, _now, model) => Effect.sync(() => void kept.charged.push({ use, model })),
      require: () =>
        Effect.suspend(() =>
          state.exhausted ? Effect.fail(new BudgetExhausted({ limit: 0, resetsAt: 0 })) : Effect.void,
        ),
    }),
    Layer.mock(Resident)({
      require: () =>
        Effect.suspend(() => (state.inactive ? Effect.fail(new ResidentInactive({ state: 'revoked' })) : Effect.void)),
    }),
  )

/**
 * The real `Decisions` (`makeDecisions`) over a node:sqlite database with the application migrations, Pi's sessions
 * as the test says them, a fake Clef (`clef: 'unbound'` for a stage without the `AI` binding), the daily budget and
 * resident authority as switches, and the change bus, flows, Clef calls, charges and aux records kept.
 */
export function decisionsFixture(options: { readonly clef?: 'unbound' } = {}) {
  const database = chatDatabase()
  const histories: Record<string, EntryRecord[]> = {}
  const state: Switches = { answer: answering(() => 0), calls: 0, exhausted: false, inactive: false, during: () => {} }
  const kept: Kept = { charged: [], reported: [], flows: [], changed: [] }
  const { transcripts, sessions } = pi(histories)
  const bus = makeChanges()
  Effect.runSync(bus.on('decisions.changed', ({ ids }) => Effect.sync(() => void kept.changed.push(...ids))))
  const services = Layer.mergeAll(
    // SAFETY: the decisions use only Drizzle's synchronous query builder, which both SQLite drivers share.
    Layer.succeed(Db, database.db as never),
    Layer.succeed(Changes, bus),
    Layer.succeed(Clef, fakeClef(state, options.clef === 'unbound')),
    SingleFlight.layer,
    KeyedLock.layer,
    FlowEvents.layerWith((event) => Effect.sync(() => void kept.flows.push(event))),
    authority(state, kept),
    sessions,
  )
  const report = (call: AuxCall) => void kept.reported.push(call)
  const runtime = ManagedRuntime.make(
    Layer.effect(Decisions, makeDecisions({ transcripts, report })).pipe(Layer.provideMerge(services)),
  )
  opened.push(async () => {
    await runtime.dispose()
    database.close()
  })
  /** Runs `program` with the decisions under test and the services they are made over. */
  const run = <A, E>(
    program: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
  ): Promise<A> => runtime.runPromise(program)
  /** Adds `session`'s next entries. */
  const say = (session: string, ...entries: EntryRecord[]) => {
    histories[session] = [...(histories[session] ?? []), ...entries]
  }
  return { ...database, ...kept, state, transcripts, run, say }
}
