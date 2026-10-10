import { PRIMARY_CHAT } from '@goblin/contracts'
import { FlowRecord } from '@goblin/contracts/inspect'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { ModelBudget, usageLedger } from '../../src/budget.ts'
import { channelPorts } from '../../src/channel/turns.ts'
import { registerPrimary } from '../../src/chats/directory.ts'
import { ModelChoiceStore, ModelPicker, modelOptions } from '../../src/models.ts'
import { FlowEvents } from '../../src/observability/flows.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { portServices } from '../chat-fixtures.ts'
import { inspectResult } from '../internal-client.ts'
import { callOwner } from '../owner-client.ts'
import { ownerCreate, ownerResult, ownerSend, snapshotOf, until, workspaceConversations } from './probe-reads.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

/** One query of the agent's inspection (`POST /internal/inspect`), answered as its `{ ok, value }` result. */
const inspect = (agent: Probe, query: object): Promise<unknown> => inspectResult(agent, query)

/** C4: the owner's create, sent twice at once under one operation id. */
export async function doubleCreateSequence(agent: Probe): Promise<Response> {
  const create = async () => ownerCreate(agent, { operationId: 'c4-double' })
  const [first, second] = await Promise.all([create(), create()])
  return Response.json({ first, second, listed: await workspaceConversations(agent) })
}

/** Two Personas tagged in a Thread started from main's composer, asked to answer one after the other. */
export async function startOrderSequence(agent: Probe): Promise<Response> {
  const persona = async (name: string) =>
    callOwner(agent, (api) =>
      api.personas.create({
        payload: {
          name,
          avatar: { glyph: name.slice(0, 1), hue: 200 },
          role: 'Reviews',
          instructions: 'Be brief.',
          exclusions: [],
          operationId: `order-${name}`,
        },
      }),
    )
  const ada = await persona('Ada')
  const bo = await persona('Bo')
  const selections = [ada, bo].map(({ id }) => ({ kind: 'persona' as const, personaId: id }))
  const started = await ownerResult(agent, (api) =>
    api.conversations.startThread({
      params: { id: PRIMARY_CHAT },
      payload: {
        operationId: 'start-order',
        anchor: 'latest',
        message: { input: 'compare the two plans', selections },
        personaOrder: 'sequence',
      },
    }),
  )
  if (!started.ok) return Response.json({ started })
  const thread = started.value.thread.id
  const entries = await until(
    async () => (await snapshotOf(agent, thread)).entries ?? [],
    (list) => list.some((entry) => entry.kind === 'app.persona_ask'),
    10_000,
  )
  return Response.json({ started, ask: entries.find((entry) => entry.kind === 'app.persona_ask')?.data })
}

/** The owner's message into main, then the same operation again: its flow rows in the run ledger. */
export async function sendFlowsSequence(agent: Probe): Promise<Response> {
  await ownerSend(agent, PRIMARY_CHAT, 'flows hello', 'flow-send')
  await ownerSend(agent, PRIMARY_CHAT, 'flows hello', 'flow-send')
  const flows = await until(
    async () => inspect(agent, { kind: 'flows', chat: PRIMARY_CHAT }),
    (result) => JSON.stringify(result).includes('replayed'),
  )
  return Response.json({ flows })
}

/**
 * The owner's Telegram message into main through the channel's submit port, twice under one operation id, over the
 * probe's own SQLite and Pi, with the flows it records.
 */
export async function telegramFlowsProbe(storage: DurableObjectStorage, harness: PiHarness) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  registerPrimary(db, 1)
  const recorded: FlowEvent[] = []
  const services = portServices({
    db,
    harness,
    budget: new ModelBudget(usageLedger(db), 300_000),
    models: new ModelPicker(new ModelChoiceStore(db), modelOptions(undefined, 'storage-only')),
    flows: FlowEvents.layerWith((event) => Effect.sync(() => void recorded.push(event))),
  })
  const twice = Effect.gen(function* () {
    const ports = yield* channelPorts(() => Effect.void)
    yield* ports.submit('hello from telegram', 'telegram-flow')
    yield* ports.submit('hello from telegram', 'telegram-flow')
  })
  await Effect.runPromise(Effect.provide(twice, services))
  return { flows: recorded }
}

/** The sequences of these cases by name, each on a fresh agent of the native worker (`/conversation-ops?case=`). */
const SEQUENCES: Readonly<Record<string, (agent: Probe) => Promise<Response>>> = {
  'c4-double': doubleCreateSequence,
  'start-order': startOrderSequence,
  'send-flows': sendFlowsSequence,
  'telegram-flows': async (agent) => Response.json(await agent.telegramFlowsProbe()),
}

/** The native worker's `/conversation-ops` route: the sequence `case` names, on the agent of the request's `name`. */
export async function conversationOpsFetch(agent: Probe, url: URL): Promise<Response> {
  const sequence = SEQUENCES[url.searchParams.get('case') ?? '']
  return sequence === undefined ? new Response('unknown case', { status: 404 }) : sequence(agent)
}

const base = (url: string) => url.replace(/\/+$/u, '')
const probe = async (url: string, name: string) =>
  (
    await fetch(`${base(url)}/conversation-ops?case=${name}&name=${name}-${Date.now()}`, {
      headers: { connection: 'close' },
    })
  ).json()

const Ok = <S extends Schema.Top>(value: S) => Schema.Struct({ ok: Schema.Literal(true), value })
const Thread = Schema.Struct({ id: Schema.String, kind: Schema.String })
const DoubleCreate = Schema.Struct({
  first: Ok(Thread),
  second: Ok(Thread),
  listed: Schema.Array(Thread),
})
const StartOrder = Schema.Struct({
  started: Ok(Schema.Struct({ thread: Thread, receipt: Schema.Struct({ operationId: Schema.String }) })),
  ask: Schema.Struct({ order: Schema.String, personas: Schema.Array(Schema.Struct({ name: Schema.String })) }),
})
const SendFlows = Schema.Struct({ flows: Ok(Schema.Struct({ flows: Schema.Array(FlowRecord) })) })
const TelegramFlows = Schema.Struct({ flows: Schema.Array(Schema.Unknown) })

/** C4: a create sent twice at once under one operation id makes one Thread, which both answers name. */
export const doubleCreateCase = (url: string) =>
  Effect.promise(async () => {
    const { first, second, listed } = await Schema.decodeUnknownPromise(DoubleCreate)(await probe(url, 'c4-double'))
    expect(second.value.id).toBe(first.value.id)
    expect(listed.filter(({ kind }) => kind === 'thread').map(({ id }) => id)).toEqual([first.value.id])
  })

/** A Thread started with tagged Personas keeps the order the message asked for them (H1), its first message `:first`. */
export const startOrderCase = (url: string) =>
  Effect.promise(async () => {
    const { started, ask } = await Schema.decodeUnknownPromise(StartOrder)(await probe(url, 'start-order'))
    expect(started.value.receipt.operationId).toBe('start-order:first')
    expect(ask.order).toBe('sequence')
    expect(ask.personas.map(({ name }) => name)).toEqual(['Ada', 'Bo'])
  })

/** A send and a Telegram message each record one flow row per run: `ok`, then `replayed` for the same operation. */
export const flowRowsCase = (url: string) =>
  Effect.promise(async () => {
    const sent = await Schema.decodeUnknownPromise(SendFlows)(await probe(url, 'send-flows'))
    const sends = sent.flows.value.flows.filter(
      ({ flow, operationId }) => flow === 'send' && operationId === 'flow-send',
    )
    expect(sends.map(({ via, actor, chat, status }) => ({ via, actor, chat, status }))).toEqual(
      expect.arrayContaining([
        { via: 'app', actor: 'owner', chat: PRIMARY_CHAT, status: 'ok' },
        { via: 'app', actor: 'owner', chat: PRIMARY_CHAT, status: 'replayed' },
      ]),
    )
    expect(sends).toHaveLength(2)
    const telegram = await Schema.decodeUnknownPromise(TelegramFlows)(await probe(url, 'telegram-flows'))
    expect(telegram.flows).toEqual([
      expect.objectContaining({ flow: 'telegram', via: 'telegram', actor: 'owner', chat: PRIMARY_CHAT, status: 'ok' }),
      expect.objectContaining({ flow: 'telegram', operationId: 'telegram-flow', status: 'replayed' }),
    ])
  })
