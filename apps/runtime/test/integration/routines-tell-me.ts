import type { RoutineDefinition } from '@goblin/contracts'
import type { PersonalAgent } from '../../src/agent.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { deliverEvents } from '../../src/inbound/client.ts'
import { CredentialCipher } from '../../src/mcp/cipher.ts'
import { CredentialStore } from '../../src/mcp/credentials.ts'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { ConnectionLabels } from '../../src/mcp/labels.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { NoticeStore } from '../../src/notices/store.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appMcpEventOffers } from '../../src/storage/schema.ts'
import type { EventsFixture } from '../mcp/events-fixture.ts'
import { ownerResult } from './probe-reads.ts'
import { changeRoutine, proposeRoutine } from './routines-owner.ts'
import { type Probes, inAgent } from './probe.ts'

const KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='
const ENDPOINT = 'https://routine-events.test/mcp'
/** Two accounts on one producer (ADR 0041): a hirer and a worker, told apart by the owner's labels. */
const CONNECTIONS = [
  { connectionId: 'sq-hirer', label: 'Sidequest · Hirer' },
  { connectionId: 'sq-worker', label: 'Sidequest · Worker' },
] as const

/** A routine that only tells the owner of `connectionId`'s messages. */
const told = (connectionId: string): RoutineDefinition => ({
  title: `Messages for ${connectionId}`,
  timezone: 'UTC',
  trigger: { kind: 'event', connectionId, name: 'message.received', arguments: {} },
  tellMe: { on: true, telegram: false },
  handTo: { kind: 'none' },
})

/** A message event the producer sends: its producer-convention title and link (ADR 0041), occurred at `at`. */
const event = (eventId: string, title: string, at = new Date()) => ({
  eventId,
  name: 'message.received',
  timestamp: at.toISOString(),
  data: { title, url: 'https://sidequest.test/jobs/12' },
})

/** The connection a webhook was sent for, from its callback URL (`/hooks/mcp-events/<user>/<connection>/<token>`). */
const connectionOf = (url: string): string => decodeURIComponent(new URL(url).pathname.split('/')[4] ?? '')

/** Both connections, labelled and signed in, with the producer's webhooks routed into the agent by their URL. */
async function setup(storage: DurableObjectStorage, agent: PersonalAgent, fixture: EventsFixture) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const cipher = await CredentialCipher.fromBase64(KEY)
  const servers = CONNECTIONS.map(({ connectionId }) => ({ connectionId, endpoint: ENDPOINT, title: 'Sidequest' }))
  const added = new AddedServerStore(db)
  const labels = new ConnectionLabels(db)
  const credentials = new CredentialStore(db, cipher)
  for (const [index, server] of servers.entries()) {
    added.add(server, 1)
    labels.set(server.connectionId, CONNECTIONS[index]?.label ?? server.connectionId)
    await credentials.saveTokens(server.connectionId, { access_token: 'keyless-fixture', token_type: 'bearer' }, 1)
  }
  bindEndpoints(db, servers, 1)
  fixture.receiver = async (request) => {
    const delivered = deliverEvents(
      { fetch: (internal) => agent.onRequest(internal) },
      {
        connectionId: connectionOf(request.url),
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
  return { db, notices: new NoticeStore(db) }
}

/**
 * Tell me end to end (ADR 0041): two connections to one producer, each subscribed through its own webhook URL, an
 * event on each posted as a notice from that connection, once; an old event replayed on a fresh subscription posts
 * nothing; the owner reads a notification; a confirmed routine answers the connection's offer of events.
 */
async function tellMeProbe(storage: DurableObjectStorage, agent: PersonalAgent, fixture: EventsFixture) {
  const { db, notices } = await setup(storage, agent, fixture)
  const routines: string[] = []
  for (const { connectionId } of CONNECTIONS) {
    const draft = await proposeRoutine(agent, told(connectionId), `tell-${connectionId}`)
    await changeRoutine(agent, draft.id, { revision: 1, operationId: `tell-${connectionId}-confirm` }, 'confirm')
    routines.push(draft.id)
  }
  const urls = [...fixture.subscriptions.entries()].filter(([id]) => id.startsWith('sub_message.received'))
  const [hirer, worker] = urls.map(([id]) => id)
  if (hirer === undefined || worker === undefined) throw new Error('two subscriptions expected')
  // An occurrence's webhook id is its event id; the worker's is delivered twice, and an old one replayed.
  await fixture.deliver(hirer, event('evt-picked', 'You picked a worker'), 'evt-picked')
  await fixture.deliver(worker, event('evt-picked', 'You were picked'), 'evt-picked')
  await fixture.deliver(worker, event('evt-picked', 'You were picked'), 'evt-picked')
  await fixture.deliver(worker, event('evt-old', 'Old news', new Date(Date.now() - 2 * 86_400_000)), 'evt-old')
  await agent.mcpEventsWake()
  await agent.routinesWake()
  const written = notices.recent(0, 100)
  const read = await ownerResult(agent, (api) => api.notices.read({ payload: { ids: written.map(({ id }) => id) } }))
  const offers = db.select().from(appMcpEventOffers).all()
  return {
    callbacks: new Set(urls.map(([, subscription]) => subscription.url)).size,
    callbackConnections: urls.map(([, subscription]) => connectionOf(subscription.url)).toSorted(),
    notices: written
      .map((notice) => ({ routine: routines.indexOf(notice.routineId), label: notice.label, title: notice.title }))
      .toSorted((a, b) => a.routine - b.routine),
    links: written.map((notice) => notice.url),
    allWritten: written.every((notice) => notice.writtenAt !== null),
    read: read.ok,
    readAt: written.every(({ id }) => notices.get(id)?.readAt !== null),
    offers: offers.map(({ connectionId, state }) => `${connectionId}:${state}`).toSorted(),
  }
}

export const probes: Probes = {
  'routine-tell-me': inAgent(({ storage, agent, producer }) => tellMeProbe(storage, agent, producer)),
}
