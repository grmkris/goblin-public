import { PRIMARY_CHAT, type RoutineDefinition } from '@goblin/contracts'
import type { PersonalAgent } from '../../src/agent.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { deliverEvents } from '../../src/inbound/client.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { CredentialStore } from '../../src/mcp/credentials.ts'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { RoutineStore } from '../../src/routines/store.ts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { appRoutineRuns, appRoutines } from '../../src/storage/routines.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import type { EventsFixture } from '../mcp/events-fixture.ts'
import type { SeenRequest } from './model.ts'
import { changeRefused, changeRoutine, editRoutine, proposeRoutine } from './routines-owner.ts'
import { type Probes, inAgent } from './probe.ts'
import { waitFor } from './until.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const includesPublicTokens = (metadata: string, modelData: string) =>
  ['0x123', '0x456'].every((token) => metadata.includes(token) && modelData.includes(token))
const definition: RoutineDefinition = {
  title: 'Native event routine',
  prompt: 'Return a short notification summary.',
  timezone: 'UTC',
  trigger: { kind: 'event', connectionId: 'routine-events', name: 'message.received', arguments: {} },
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
}
async function draft(agent: PersonalAgent, operation: string, input = definition) {
  return proposeRoutine(agent, input, `${operation}-draft`)
}
async function confirm(agent: PersonalAgent, id: string, revision: number, operation: string) {
  return changeRoutine(agent, id, { revision, operationId: `${operation}-confirm` }, 'confirm')
}
/** Until routine `id` has `count` runs, all completed. */
const wait = (store: RoutineRunStore, id: string, count: number) =>
  waitFor(
    () => store.list(id),
    (runs) => runs.length === count && runs.every((run) => run.state === 'completed'),
    'the routine Events runs',
    3000,
  )
async function setup(storage: DurableObjectStorage, agent: PersonalAgent, fixture: EventsFixture) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const cipher = await CredentialCipher.fromBase64(KEY)
  const server = {
    connectionId: 'routine-events',
    endpoint: 'https://routine-events.test/mcp',
    title: 'Events fixture',
  }
  new AddedServerStore(db).add(server, 1)
  bindEndpoints(db, [server], 1)
  await new CredentialStore(db, cipher).saveTokens(
    server.connectionId,
    { access_token: 'keyless-fixture', token_type: 'bearer' },
    1,
  )
  fixture.receiver = async (request) => {
    const delivered = deliverEvents(
      { fetch: (internal) => agent.onRequest(internal) },
      {
        connectionId: 'routine-events',
        body: new Uint8Array(await request.arrayBuffer()),
        id: request.headers.get('webhook-id') ?? '',
        timestamp: request.headers.get('webhook-timestamp') ?? '',
        signature: request.headers.get('webhook-signature') ?? '',
        subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
      },
    )
    const result = await Effect.runPromiseExit(delivered)
    return Exit.isSuccess(result)
      ? new Response(result.value.response ?? null, { status: result.value.status })
      : new Response(null, { status: 400 })
  }
  return {
    db,
    routines: new RoutineStore(db, agent.name),
    runs: new RoutineRunStore(db, agent.name),
    events: new SqliteEventStore(db),
    cipher,
  }
}

/** Official MCP producer, signed ingress, real Agent/Pi/SQLite and keyless model; no provider or Telegram send. */
async function routineEventsProbe(
  storage: DurableObjectStorage,
  agent: PersonalAgent,
  fixture: EventsFixture,
  seen: readonly SeenRequest[],
) {
  const state = await setup(storage, agent, fixture)
  const first = await draft(agent, 'first')
  const before = fixture.calls.length
  const noDraftSubscription = state.events.activeConsumer(`routine:${first.id}`) === undefined && before === 0
  const active = await confirm(agent, first.id, 1, 'first')
  await confirm(agent, first.id, 1, 'first')
  const second = await draft(agent, 'second')
  await confirm(agent, second.id, 1, 'second')
  const lease = state.events.activeConsumer(`routine:${first.id}`)
  const shared = lease?.subscriptionId === state.events.activeConsumer(`routine:${second.id}`)?.subscriptionId
  await changeRoutine(agent, second.id, { revision: 1, operationId: 'second-pause' }, 'pause')
  const leavingSharedKeptRemote = fixture.subscriptions.has('sub_message.received')
  const deliver = (id: string, signature?: string) =>
    fixture.deliver(
      'sub_message.received',
      {
        eventId: id,
        name: 'message.received',
        timestamp: new Date().toISOString(),
        data: {
          entryIds: ['fixture-1'],
          instructions: 'untrusted fixture data',
          rewardToken: '0x123',
          token: '0x456',
          nested: [{ accessToken: 'fixture-private', refresh_token: 'fixture-private' }],
        },
      },
      id,
      signature === undefined ? {} : { signature },
    )
  const bad = await deliver('evt_bad', 'v1,bad')
  const received = await deliver('evt:one/%')
  await agent.mcpEventsWake()
  await wait(state.runs, first.id, 1)
  await agent.routinesWake()
  await deliver('evt:one/%')
  await agent.mcpEventsWake()
  const one = state.runs.list(first.id)[0]
  const raw = one === undefined ? undefined : state.runs.get(one.id)
  const metadata = raw?.eventDataSealed
    ? await state.cipher.decrypt(raw.eventDataSealed, `routine-event:${raw.operationId}:${raw.revision}`)
    : ''
  await deliver('evt_two')
  await deliver('evt_three')
  await agent.mcpEventsWake()
  const queued = state.routines.get(first.id)
  const pending =
    queued.pendingTrigger === null
      ? ''
      : await state.cipher.decrypt(queued.pendingTrigger, `routine-pending:${first.id}:1`)
  const beforeReplay = queued.suppressedCount
  const spacedOneRun = state.runs.list(first.id).length === 1
  await deliver('evt_two')
  await agent.mcpEventsWake()
  const pendingReplayNoop = state.routines.get(first.id).suppressedCount === beforeReplay
  await confirm(agent, second.id, state.routines.view(second.id).revision, 'second-resume')
  await deliver('evt_global_spacing')
  await agent.mcpEventsWake()
  const globalSpacing = state.runs.list(second.id).length === 0 && state.routines.get(second.id).pendingTrigger !== null
  await changeRoutine(
    agent,
    second.id,
    { revision: state.routines.view(second.id).revision, operationId: 'second-pause-again' },
    'pause',
  )
  state.db
    .update(appRoutineRuns)
    .set({ admittedAt: Date.now() - 61_000 })
    .run()
  await agent.routinesWake()
  await wait(state.runs, first.id, 2)
  const drainedActive =
    state.routines.get(first.id).state === 'active' && state.routines.get(first.id).pendingTrigger === null
  const callsBeforeGap = seen.length
  await fixture.deliver('sub_message.received', { type: 'gap', cursor: '0' }, 'msg_gap_routine')
  await agent.mcpEventsWake()
  const gapNoModel = seen.length === callsBeforeGap
  const pollRecovery = fixture.calls.includes('events/poll')
  await fixture.deliver(
    'sub_message.received',
    { type: 'terminated', error: { code: -32012 } },
    'msg_terminated_routine',
  )
  await agent.mcpEventsWake()
  await agent.routinesWake()
  const paused = state.routines.view(first.id)
  const countBeforeResume = state.runs.list(first.id).length
  await confirm(agent, first.id, paused.revision, 'resume')
  const resumed = state.routines.view(first.id)
  // Simulate receipt retention expiry; run identity must still dedupe across consumer revisions.
  state.events.prune(Date.now() + 9 * 86_400_000)
  await deliver('evt:one/%')
  await agent.mcpEventsWake()
  const revisedReplayNoop =
    state.runs.list(first.id).length === countBeforeResume &&
    state.routines.get(first.id).pendingTrigger === null &&
    state.events.work(Date.now() + 600_000).length === 0
  const oldPendingGone = state.routines.get(first.id).pendingTrigger === null
  await editRoutine(agent, first.id, {
    revision: resumed.revision,
    operationId: 'event-edit',
    definition: { ...definition, prompt: 'Changed draft' },
  })
  const editedNoBinding = state.events.activeConsumer(`routine:${first.id}`) === undefined
  const noStaleRun = state.runs.list(first.id).length === countBeforeResume
  const requests = seen.filter((request) =>
    request.messages.some((message) => message.text.includes('Confirmed routine: Native event routine')),
  )
  const modelData = requests.flatMap((request) => request.messages.map((message) => message.text)).join('\n')
  fixture.inputSchema = {
    type: 'object',
    properties: { botId: { type: 'string' } },
    required: ['botId'],
    additionalProperties: false,
  }
  const invalid = await draft(agent, 'invalid', {
    ...definition,
    trigger: { kind: 'event', connectionId: 'routine-events', name: 'message.received', arguments: { botId: 7 } },
  })
  const callsBeforeInvalid = fixture.calls.filter((call) => call === 'events/subscribe').length
  const invalidConfirmationRefused = await changeRefused(
    agent,
    invalid.id,
    { revision: 1, operationId: 'invalid-confirm' },
    'confirm',
  )
  const invalidArgumentsRejected =
    invalidConfirmationRefused &&
    state.events.activeConsumer(`routine:${invalid.id}`) === undefined &&
    fixture.calls.filter((call) => call === 'events/subscribe').length === callsBeforeInvalid
  return {
    noDraftSubscription,
    active: active.state,
    shared,
    leavingSharedKeptRemote,
    bad: bad.status,
    received: received.status,
    replayOneRun: raw?.operationId === `routine:${first.id}:evt%3Aone%2F%25`,
    metadataSealed: !!raw?.eventDataSealed && !raw.eventDataSealed.includes('fixture-private'),
    scrubbedMetadata: !metadata.includes('fixture-private'),
    publicTokensPreserved: includesPublicTokens(metadata, modelData),
    metadataLabelled: modelData.includes('Untrusted event metadata') && !modelData.includes('fixture-private'),
    spacedOneRun,
    pendingLatest: pending.includes('evt_three'),
    pendingReplayNoop,
    globalSpacing,
    invalidArgumentsRejected,
    drainedActive,
    gapNoModel,
    pollRecovery,
    terminatedPaused: paused.state === 'paused',
    resumed: resumed.state === 'active',
    freshRevision: resumed.revision === 2,
    revisedReplayNoop,
    oldPendingGone,
    editedNoBinding,
    noStaleRun,
    main: PRIMARY_CHAT,
    count: state.db.select().from(appRoutines).all().length,
  }
}

export const probes: Probes = {
  'routine-events': inAgent(({ storage, agent, producer, seen }) => routineEventsProbe(storage, agent, producer, seen)),
}
