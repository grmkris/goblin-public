import {
  type ConversationId,
  type EntryId,
  type Harness,
  type EntryRecord,
  type PhaseHandler,
  LiveDoc,
  type SettledSubmissionRecord,
  type Task,
  type TaskId,
  type TaskRecord,
  type Tx,
  defineDoc,
  defineTask,
} from '@earendil-works/pi-durable'
import type { UserMessage } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type DelegateResultData, type HelperExclusion } from '@goblin/contracts'
import { Channel, Chats, Conversations, attempt, attemptSync, nowSecondsEffect, requireResident } from '../services.ts'
import { authoredContent } from './content.ts'
import { BACKGROUND, entryId, conversationId as piConversationId } from './context.ts'
import type { RunProgram } from './resident-mcp.ts'

/**
 * The task that carries one message to a subagent and its answer back to the spawner. While one is live in a
 * conversation, that conversation waits on its subagents.
 */
export const SUBAGENT_RELAY = 'goblin.subagent-relay'

export type Subagent = {
  readonly conversationId: ConversationId
  /** Answers already reported: several messages can end in one answer, reported once. */
  readonly reported: EntryId[]
  /** What the owner wrote to it since its last report, quoted in the next one. */
  quotes?: string[]
  /** The spawn asked for synthesis: its report is an input Goblin answers once, not a passive result (spec §5). */
  synthesize?: boolean
}

/** The subagents a conversation started, by name. A thread branched from main starts without main's. */
export const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
  kind: 'app.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {} }),
})

export type RelayInput = {
  readonly name: string
  readonly conversationId: ConversationId
  /** What the subagent receives. */
  readonly content: UserMessage['content']
  /** Who wrote it: the spawner's agent, through its tool, or the owner, in the subagent's conversation. */
  readonly origin: 'spawner' | 'owner'
  readonly whenBusy: 'followUp' | 'steer'
  /** The owner's message, quoted in the report: the spawner learns what it was asked. */
  readonly quote?: string
  /** The owner's operation id: the submission carries it, so their browser waits on it like on any message. */
  readonly requestId?: string
  readonly exclusions?: readonly HelperExclusion[]
  /** Whether its report is an input the spawner answers (`synthesize`), else a passive Delegate result. */
  readonly synthesize?: boolean
}

type RelayState =
  | { readonly phase: 'deliver' }
  /** The message was answered at `after`; waiting until the subagent and its own helpers are done. */
  | { readonly phase: 'drain'; readonly after: number; readonly round: number }
  /** `close`: it ended in an answer, so it closes as done unless the owner keeps it. */
  | { readonly phase: 'report'; readonly report?: string; readonly close: boolean; readonly failed?: boolean }

export type Relay = Task<RelayInput, RelayState, null, object>

export const background = { ownership: { kind: 'conversation' }, background: true } as const

const toReport = (close: boolean, report?: string, failed = false) =>
  ({
    status: 'running',
    checkpoint: { phase: 'report', close, ...(report === undefined ? {} : { report }), ...(failed ? { failed } : {}) },
  }) as const

/** The text of an answer entry; empty when it has none (a run that a tool ended). */
export function answerText(entry: Pick<EntryRecord, 'model'> | undefined): string {
  const message = entry?.model?.[0]
  if (message?.role !== 'assistant') return ''
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** A run the owner or a Stop cut short: nothing to report from it. */
const stopped = (entry: EntryRecord) => {
  const message = entry.model?.[0]
  return message?.role === 'assistant' && message.stopReason === 'aborted'
}

/** The most a Delegate result entry keeps for display; the chat's model reads the whole report. */
const RESULT_TEXT = 8000

const LIVE = ['pending', 'running', 'waiting', 'completing'] as const

/** The relays still at work in `conversation`: those of its own subagents when it is a subagent. */
export async function liveRelays(
  tx: Tx,
  conversation: ConversationId,
): Promise<readonly TaskRecord<unknown, unknown, unknown>[]> {
  const pages = await Promise.all(
    LIVE.map((status) => tx.scanTasks({ conversationId: conversation, kind: SUBAGENT_RELAY, status }, 100)),
  )
  return pages.flatMap((page) => page.items)
}

/** What a stored relay input says about where it goes, read back from Pi's JSON. */
const Carried = Schema.Struct({ conversationId: Schema.Number, requestId: Schema.optional(Schema.String) })
const carried = (relay: TaskRecord<unknown, unknown, unknown>) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Carried)(relay.input))

/**
 * Stops the relays carrying messages to `subagent` from `spawner`, before the subagent itself stops: one that was
 * waiting on it would otherwise wake and report a job cut short.
 */
export async function dropRelaysTo(pi: Harness, spawner: ConversationId, subagent: ConversationId): Promise<void> {
  const { tasks } = await pi.inspect(BACKGROUND)
  for (const { record } of tasks)
    if (record.kind === SUBAGENT_RELAY && record.conversationId === spawner && carriesTo(record, subagent))
      await pi.abortTask(record.id, BACKGROUND)
}

/** Whether a relay carries a message to subagent `conversation`. */
export const carriesTo = (relay: TaskRecord<unknown, unknown, unknown>, conversation: ConversationId) =>
  carried(relay)?.conversationId === Number(conversation)

/** Whether a relay carries the owner's operation `requestId`. */
export const carriesRequest = (relay: TaskRecord<unknown, unknown, unknown>, requestId: string) =>
  carried(relay)?.requestId === requestId

const Phase = Schema.Struct({ checkpoint: Schema.Struct({ phase: Schema.String }) })
/** A relay that has not decided its report yet: still delivering, or waiting for its subagent to finish. */
const undecided = (relay: TaskRecord<unknown, unknown, unknown>) => {
  const phase = Option.getOrUndefined(Schema.decodeUnknownOption(Phase)(relay.state))?.checkpoint.phase
  return phase === 'deliver' || phase === 'drain'
}

/** The owner's words as the report quotes them: one line, at most 300 characters. */
export const quoted = (text: string) => {
  const line = text.replaceAll(/\s+/gu, ' ').trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/** After the message was answered: wait for the subagent to finish, or report what stopped it. */
function delivered(settled: SettledSubmissionRecord) {
  if (settled.status === 'unanswered')
    return toReport(false, settled.reason === 'aborted' ? undefined : `It failed: ${settled.reason}.`, true)
  if (settled.type !== 'input') return toReport(false)
  return { status: 'running', checkpoint: { phase: 'drain', after: Number(settled.entry), round: 0 } } as const
}

/**
 * What the drained subagent reports, decided in one commit so a restart does not decide again. While another message
 * to it is still on its way, nothing: that relay reports the answer to both, with what the owner wrote kept for it.
 * Otherwise its newest answer since the message, once, after the owner's words since its last report; then it closes
 * as done. A run cut short reports nothing.
 */
async function decide(tx: Tx, spawner: ConversationId, self: TaskId, input: RelayInput, after: number) {
  const agent = (await tx.doc(Subagents, spawner)).agents[input.name]
  const others = await liveRelays(tx, spawner)
  if (others.some((relay) => relay.id !== self && carriesTo(relay, input.conversationId) && undecided(relay))) {
    if (agent !== undefined && input.quote !== undefined) agent.quotes = [...(agent.quotes ?? []), input.quote]
    return toReport(false)
  }
  const recent = await tx.scanEntries({ conversationId: input.conversationId, minEntryId: entryId(after + 1) }, 20)
  const answer = recent.items.find((entry) => entry.kind === 'pi.assistant')
  if (answer === undefined || stopped(answer)) return toReport(false)
  if (agent?.reported.includes(answer.id) === true) return toReport(true)
  const quotes = [...(agent?.quotes ?? []), ...(input.quote === undefined ? [] : [input.quote])]
  if (agent !== undefined) {
    agent.reported.push(answer.id)
    agent.quotes = []
  }
  const text = answerText(answer)
  if (text === '') return toReport(false, 'It ended without an answer; its conversation shows why.', true)
  return toReport(true, [...quotes.map((quote) => `The owner wrote to it: "${quote}"`), text].join('\n\n'))
}

type ReportPhase = PhaseHandler<RelayInput, Extract<RelayState, { readonly phase: 'report' }>, RelayState, null, object>

/**
 * The report reaches the spawner's chat as a passive Delegate result (spec section 5): Goblin sees it at its next turn
 * and does not answer it, unless the spawn asked for synthesis, when it is an input that starts or joins a turn.
 */
const reportPhase =
  (run: RunProgram): ReportPhase =>
  async (relay, runtime, context) => {
    const { report, close, failed = false } = relay.state.checkpoint
    const { name, conversationId, origin, synthesize = false } = relay.input
    if (report !== undefined) {
      await run(requireResident)
      const chats = await run(Chats.useSync((directory) => directory))
      const parentChat = chats.chatOf(String(runtime.conversationId))
      if (parentChat === undefined) throw new Error('Subagent spawner is not registered')
      const requestId = `subagent-report:${relay.id}`
      const content = authoredContent(`subagent ${name}`, report)
      if (synthesize) {
        await chats.passiveWrite(parentChat, async (session) => {
          const spawner = await runtime.conversation(piConversationId(session), context)
          if (parentChat === chats.primary() && origin === 'spawner') await run(track(requestId))
          await spawner?.submit({ type: 'input', content, whenBusy: 'followUp', requestId }, context)
        })
      } else {
        const data = {
          delegate: String(conversationId),
          name,
          status: failed ? 'failed' : 'done',
          text: report.slice(0, RESULT_TEXT),
        } satisfies DelegateResultData
        const model = [{ role: 'user' as const, content, timestamp: Date.now() }]
        await run(
          Conversations.use((conversations) =>
            attempt(() =>
              conversations.writeEntry(parentChat, requestId, { kind: 'app.delegate_result', data, model }),
            ),
          ),
        )
      }
    }
    if (close) await run(closeAsDone(String(conversationId)))
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
  }

/**
 * Carries one message to a subagent (its spawner's or the owner's), then waits until the subagent is done: idle, with
 * none of its own helpers still at work, so it reports its final answer, never "waiting on my helpers". The answer goes
 * to the spawner's chat as a passive Delegate result (an input it answers once when the spawn asked for `synthesize`),
 * and only there. Then the subagent closes as done unless the owner wrote in
 * it, branched from it or pinned it. Request ids keep a restart from delivering or reporting twice.
 */
export function relayTask(run: RunProgram): Relay {
  return defineTask<RelayInput, RelayState, null>({
    name: SUBAGENT_RELAY,
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (relay, runtime, context) => {
        const { name, conversationId, content, whenBusy, origin, requestId } = relay.input
        const parent = String(runtime.conversationId)
        if (origin === 'spawner')
          await run(register(String(conversationId), parent, name, relay.input.exclusions ?? []))
        const subagent = await runtime.conversation(conversationId, context)
        if (subagent === undefined) throw new Error(`Subagent ${name} has no conversation`)
        await run(requireResident)
        const submission = await subagent.submit(
          { type: 'input', content, whenBusy, requestId: requestId ?? `subagent:${relay.id}` },
          context,
        )
        const settled = await submission.wait(context)
        await runtime.commit(() => delivered(settled), context)
      },
      drain: async (relay, runtime, context) => {
        const { after, round } = relay.state.checkpoint
        const { conversationId } = relay.input
        const next = { phase: 'drain', after, round: round + 1 } as const
        if ((await runtime.snapshot(LiveDoc, conversationId, context))?.run !== undefined) {
          await (await runtime.conversation(conversationId, context))?.waitForIdle(context)
          return runtime.commit(() => ({ status: 'running', checkpoint: next }), context)
        }
        await runtime.commit(async (tx) => {
          const helpers = await liveRelays(tx, conversationId)
          if (helpers.length > 0)
            return {
              status: 'waiting',
              checkpoint: next,
              on: helpers.map(({ id }) => id),
              policy: 'allSettled',
            } as const
          return decide(tx, runtime.conversationId, relay.id, relay.input, after)
        }, context)
      },
      report: reportPhase(run),
    },
    abort: (_relay, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

/** Lists a subagent under its spawner; each relay repeats it, so it is idempotent. */
const register = (session: string, parent: string, name: string, exclusions: readonly HelperExclusion[]) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    yield* attemptSync(() => conversations.registerSubagent(session, parent, name, now, exclusions))
  })

/** Main's answer to its own subagent's report goes to Telegram too when the channel is on (channel/channel.ts). */
const track = (requestId: string) =>
  Effect.gen(function* () {
    const channel = yield* Channel
    const chats = yield* Chats
    const now = yield* nowSecondsEffect
    chats.admit(chats.primary(), requestId, now)
    channel.track(requestId, now)
  })

/** A subagent whose job is done closes, with everything under it, unless the owner keeps it open. */
const closeAsDone = (session: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const view = yield* attempt(() => conversations.view(session))
    if (view === undefined || view.keepOpen || view.closedAt !== undefined) return
    const now = yield* nowSecondsEffect
    yield* attempt(() => conversations.close(session, 'done', now))
  })
