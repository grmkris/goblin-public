import type { PiHarness } from 'agents/harness/pi'
import { ChatDirectory, registerPrimary } from '../../src/chats/directory.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { TelegramChannel, channelTool } from '../../src/channel/channel.ts'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { CollectedRuns, RunTelemetry } from '../../src/telemetry/events.ts'
import { mcpReporter } from '../../src/telemetry/report.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { GrantDenied, attempt } from '../../src/http/errors.ts'
import { type EventsOptions, makeEvents } from '../../src/mcp/events.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { makeManager } from '../../src/mcp/manager.ts'
import { offersEvents } from '../../src/mcp/remote.ts'
import { McpConnections } from '../../src/mcp/service.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { channelPorts } from '../../src/channel/turns.ts'
import { ModelBudget, usageLedger } from '../../src/budget.ts'
import { ModelChoiceStore, ModelPicker, modelOptions } from '../../src/models.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appEventDeliveries } from '../../src/storage/schema.ts'
import { portServices } from '../chat-fixtures.ts'
import { EventsFixture } from '../mcp/events-fixture.ts'
import type { EventEnvelope } from '../../src/mcp/events/protocol.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { eventsSkillsProbe, eventsRecoveryProbe } from './events-recovery.ts'
import { servicesOf } from '../mcp/runtime.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const occurrence = (fixture: EventsFixture, eventId: string): EventEnvelope => ({
  eventId,
  name: 'message.received',
  timestamp: new Date(fixture.now).toISOString(),
  data: { inboxCursor: fixture.cursor },
  cursor: fixture.cursor,
})

async function setup(storage: DurableObjectStorage, harness: PiHarness) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  registerPrimary(db, 1)
  const chats = new ChatDirectory(db)
  const store = new SqliteEventStore(db)
  const skillState = new SqliteSkillState(db)
  const cipher = await CredentialCipher.fromBase64(KEY)
  const fixture = new EventsFixture()
  const runs = new CollectedRuns()
  const telemetry = new RunTelemetry([runs])
  const wakes: number[] = []
  // The probe's services: the connections over the fixture, on a test clock the probe moves with the fixture's.
  const services = servicesOf(
    Layer.effect(
      McpConnections,
      Effect.orDie(
        makeManager({
          servers: [{ serverId: 'mygram', endpoint: 'https://events.test/mcp' }],
          allows: () => true,
          skillsEnabled: (serverId) => skillState.enabled(serverId),
          auth: () => ({ token: async () => 'synthetic-fixture-bearer' }),
          fetch: (input, init) => fixture.fetch(input, init),
          report: mcpReporter(telemetry),
        }),
      ),
    ).pipe(Layer.provideMerge(Layer.mergeAll(SingleFlight.layer, TestClock.layer()))),
  )
  const { run } = services
  await run(TestClock.setTime(fixture.now))
  const connections = await run(McpConnections)
  const channel = new TelegramChannel(db, cipher, () => undefined, telemetry, chats)
  const eventOptions: EventsOptions = {
    connections,
    store,
    cipher,
    principal: 'fixture-owner',
    callback: 'https://goblin.test/hooks/mcp-events/fixture/token',
    authority: Effect.void,
    authorize: (serverId, name, args) =>
      store.allows(serverId, name, args) ? Effect.void : Effect.fail(new GrantDenied({ serverId, name })),
    wake: (at) =>
      Effect.sync(() => {
        wakes.push(at)
      }),
  }
  const events = await run(makeEvents(eventOptions))
  fixture.receiver = async (request) => {
    const exit = await run(
      Effect.exit(
        events.receive({
          body: new Uint8Array(await request.arrayBuffer()),
          id: request.headers.get('webhook-id') ?? '',
          timestamp: request.headers.get('webhook-timestamp') ?? '',
          signature: request.headers.get('webhook-signature') ?? '',
          subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
        }),
      ),
    )
    if (Exit.isFailure(exit)) return new Response(null, { status: 400 })
    return new Response(exit.value.response ?? null, { status: exit.value.status })
  }
  const operations: string[] = []
  const budget = new ModelBudget(usageLedger(db), 300_000)
  const models = new ModelPicker(new ModelChoiceStore(db), modelOptions(undefined, 'storage-only'))
  const portRun: Parameters<typeof channelPorts>[1] = (program) =>
    Effect.runPromise(program.pipe(Effect.provide(portServices({ db, harness, budget, models }))))
  /** A tool of the channel server, as the channel calls it. */
  const call = (name: string, args: Record<string, unknown>) => run(channelTool(connections, 'mygram')(name, args))
  const ports = channelPorts(call, portRun)
  const pull = () =>
    channel.pull(
      {
        ...ports,
        submit: async (text, operationId) => {
          operations.push(operationId)
          await ports.submit(text, operationId)
        },
        answer: async () => undefined,
      },
      Math.floor(fixture.now / 1000),
    )
  await run(
    events.register('telegram-inbox', ({ envelope }) =>
      'type' in envelope && envelope.type === 'terminated' ? Effect.void : attempt(pull),
    ),
  )
  return {
    db,
    chats,
    runs,
    store,
    cipher,
    fixture,
    connections,
    channel,
    events,
    eventOptions,
    skillState,
    run,
    dispose: services.dispose,
    call,
    /** Moves the fixture's clock and the agent's together. */
    clock: async (at: number) => {
      fixture.now = at
      await run(TestClock.setTime(at))
    },
    wakes,
    operations,
    pull,
  }
}

export type EventsProbeState = Awaited<ReturnType<typeof setup>>

async function subscribeTelegram(state: Awaited<ReturnType<typeof setup>>) {
  for (const name of ['message.received', 'question.answered']) {
    state.store.grant('mygram', name, '{}', true, state.fixture.now)
    await state.run(
      state.events.subscribe({
        consumerId: `telegram:${name}`,
        revision: 1,
        serverId: 'mygram',
        name,
        arguments: {},
        handlerKey: 'telegram-inbox',
      }),
    )
  }
  await state.run(
    state.events.subscribe({
      consumerId: 'second-consumer',
      revision: 1,
      serverId: 'mygram',
      name: 'message.received',
      arguments: {},
      handlerKey: 'telegram-inbox',
    }),
  )
  state.channel.enableEvents('mygram', '0', Math.floor(state.fixture.now / 1000))
}

async function exercise(state: Awaited<ReturnType<typeof setup>>) {
  const { fixture, events, store, channel, operations, run } = state
  const first = fixture.now
  fixture.cursor = '1'
  fixture.inbox.push({ id: 'tg:123', text: 'Events fixture hello', direction: 'in' })
  const envelope = occurrence(fixture, 'evt_1')
  const received = await fixture.deliver('sub_message.received', envelope, 'evt_1')
  await run(events.dispatch())
  const replayed = await fixture.deliver('sub_message.received', envelope, 'evt_1')
  await run(events.dispatch())
  const bad = await fixture.deliver('sub_message.received', occurrence(fixture, 'evt_bad'), 'evt_bad', {
    signature: 'v1,invalid',
  })
  const old = await fixture.deliver('sub_message.received', occurrence(fixture, 'evt_old'), 'evt_old', {
    timestamp: String(Math.floor(first / 1000) - 301),
  })
  fixture.cursor = '2'
  fixture.inbox.splice(0, fixture.inbox.length, { id: 'tg:124', text: 'Recovered gap answer', direction: 'in' })
  fixture.journal.push({
    eventId: 'evt_2',
    name: 'message.received',
    timestamp: new Date(first).toISOString(),
    data: { inboxCursor: '2' },
    cursor: '2',
  })
  await fixture.deliver('sub_message.received', { type: 'gap', cursor: '1' }, 'msg_gap_fixture')
  await run(events.maintain())
  const beforeRefresh = fixture.calls.filter((m) => m === 'events/subscribe').length
  await state.clock(first + 3_600_000 - 299_000)
  await run(events.maintain())
  const refreshedEarly = fixture.calls.filter((m) => m === 'events/subscribe').length > beforeRefresh
  await fixture.deliver(
    'sub_message.received',
    { type: 'terminated', error: { code: -32012 } },
    'msg_terminated_fixture',
  )
  await run(events.maintain())
  const terminated = store.selector('mygram', 'message.received', '{}')?.status
  const cleanup = await run(events.unsubscribe({ consumerId: 'telegram:message.received', revision: 1 }))
  const sharedPreserved = fixture.subscriptions.has('sub_message.received')
  await run(events.unsubscribe({ consumerId: 'second-consumer', revision: 1 }))
  await run(events.unsubscribe({ consumerId: 'telegram:question.answered', revision: 1 }))
  // The first message's turn answered; the second still runs: one reply goes out, one waits.
  const answers = { call: state.call, submit: async () => undefined }
  const waiting = await channel.deliver(
    { ...answers, answer: async (operationId) => (operationId === 'telegram-tg-123' ? 'hello back' : undefined) },
    Math.floor(first / 1000),
  )
  channel.disable()
  return {
    waiting,
    received: received.status,
    replayed: replayed.status,
    bad: bad.status,
    old: old.status,
    operations,
    refreshedEarly,
    terminated,
    cleanup,
    remainingRemote: fixture.subscriptions.size,
    sharedPreserved,
    pollRecovered: fixture.calls.includes('events/poll'),
    challengeReceipts: state.db
      .select()
      .from(appEventDeliveries)
      .all()
      .filter((r) => r.kind === 'verification').length,
  }
}

/** The channel's run events, and how the inbox calls to the server went (ADR 0024). */
const runSummary = (events: readonly RunEvent[]) => ({
  channel: events
    .filter((event) => event.kind === 'channel.received' || event.kind === 'channel.reply')
    .map((event) => ({
      kind: event.kind,
      status: event.status,
      operationId: event.operationId,
      delivery: event.attributes[RunAttribute.delivery],
      message: event.attributes[RunAttribute.channelMessage],
    })),
  inbox: events.filter(
    (event) =>
      event.kind === 'mcp.request' && event.attributes[RunAttribute.mcpTool] === 'inbox' && event.status === 'ok',
  ).length,
})

/** Real workerd SQLite + official MCP transport + native PiHarness. No model/provider/network traffic. */
export async function eventsProbe(storage: DurableObjectStorage, harness: PiHarness) {
  const state = await setup(storage, harness)
  try {
    await subscribeTelegram(state)
    const discovered = offersEvents(await state.run(state.connections.connect('mygram')))
    const result = await exercise(state)
    const skills = await eventsSkillsProbe(state)
    const recovery = await eventsRecoveryProbe(state)
    const messages = await harness.messages({ session: state.chats.session(state.chats.primary()) })
    return {
      ...result,
      discovered,
      skills,
      recovery,
      messageCount: messages.length,
      scheduledRecovery: state.wakes.length > 0,
      runs: runSummary(state.runs.events()),
    }
  } finally {
    await state.dispose()
  }
}
