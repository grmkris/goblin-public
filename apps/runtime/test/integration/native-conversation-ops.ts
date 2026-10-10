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
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { Ok } from './conversation-checks.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, inAgent, inWorker } from './probe.ts'
import { ownerCreate, ownerResult, ownerSend, snapshotOf, workspaceConversations } from './probe-reads.ts'
import { until } from './until.ts'

/** C4: the owner's create, sent twice at once under one operation id. */
async function doubleCreateSequence(agent: AgentFetch) {
  const create = async () => ownerCreate(agent, { operationId: 'c4-double' })
  const [first, second] = await Promise.all([create(), create()])
  return { first, second, listed: await workspaceConversations(agent) }
}

/** Two Personas tagged in a Thread started from main's composer, asked to answer one after the other. */
async function startOrderSequence(agent: AgentFetch) {
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
  if (!started.ok) return { started }
  const thread = started.value.thread.id
  const entries = await until(
    async () => (await snapshotOf(agent, thread)).entries ?? [],
    (list) => list.some((entry) => entry.kind === 'app.persona_ask'),
    10_000,
  )
  return { started, ask: entries.find((entry) => entry.kind === 'app.persona_ask')?.data }
}

/** The owner's message into main, then the same operation again: its flow rows in the run ledger. */
async function sendFlowsSequence(agent: AgentFetch) {
  await ownerSend(agent, PRIMARY_CHAT, 'flows hello', 'flow-send')
  await ownerSend(agent, PRIMARY_CHAT, 'flows hello', 'flow-send')
  const flows = await until(
    async () => inspectResult(agent, { kind: 'flows', chat: PRIMARY_CHAT }),
    (result) => JSON.stringify(result).includes('replayed'),
  )
  return { flows }
}

/**
 * The owner's Telegram message into main through the channel's submit port, twice under one operation id, over the
 * probe's own SQLite and Pi, with the flows it records.
 */
async function telegramFlowsProbe(storage: DurableObjectStorage, harness: PiHarness) {
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

export const probes: Probes = {
  'c4-double': inWorker(({ agent }) => doubleCreateSequence(agent)),
  'start-order': inWorker(({ agent }) => startOrderSequence(agent)),
  'send-flows': inWorker(({ agent }) => sendFlowsSequence(agent)),
  'telegram-flows': inAgent(({ storage, harness }) => telegramFlowsProbe(storage, harness)),
}

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

/** A send and a Telegram message each record one flow row per run: `ok`, then `replayed` for the same operation. */
async function flowRows(base: string): Promise<void> {
  const sent = await probeOf(base, 'send-flows', SendFlows)
  const sends = sent.flows.value.flows.filter(({ flow, operationId }) => flow === 'send' && operationId === 'flow-send')
  expect(sends.map(({ via, actor, chat, status }) => ({ via, actor, chat, status }))).toEqual(
    expect.arrayContaining([
      { via: 'app', actor: 'owner', chat: PRIMARY_CHAT, status: 'ok' },
      { via: 'app', actor: 'owner', chat: PRIMARY_CHAT, status: 'replayed' },
    ]),
  )
  expect(sends).toHaveLength(2)
  const telegram = await probeOf(base, 'telegram-flows', TelegramFlows)
  expect(telegram.flows).toEqual([
    expect.objectContaining({ flow: 'telegram', via: 'telegram', actor: 'owner', chat: PRIMARY_CHAT, status: 'ok' }),
    expect.objectContaining({ flow: 'telegram', operationId: 'telegram-flow', status: 'replayed' }),
  ])
}

/** The conversation operation cases: one Thread per create operation, Persona order, and the flow rows of a send. */
export const cases: readonly NativeCase[] = [
  {
    // C4: both answers name the one Thread.
    title: 'a create sent twice at once under one operation id makes one Thread (C4)',
    run: async (base) => {
      const { first, second, listed } = await probeOf(base, 'c4-double', DoubleCreate)
      expect(second.value.id).toBe(first.value.id)
      expect(listed.filter(({ kind }) => kind === 'thread').map(({ id }) => id)).toEqual([first.value.id])
    },
  },
  {
    // H1: the order the message asked for, and the Thread's first message is `:first`.
    title: 'a Thread started with tagged Personas keeps the order the message asks for them',
    run: async (base) => {
      const { started, ask } = await probeOf(base, 'start-order', StartOrder)
      expect(started.value.receipt.operationId).toBe('start-order:first')
      expect(ask.order).toBe('sequence')
      expect(ask.personas.map(({ name }) => name)).toEqual(['Ada', 'Bo'])
    },
  },
  {
    title: 'a send and a Telegram message each record their flow row, a repeat of either as replayed [canary]',
    run: flowRows,
  },
]
