import { OrganizeGroup, PersonasGroup, SubscriptionRequired, TopicsGroup, ownerApiOf } from '@goblin/contracts/api'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach } from 'vitest'
import type { AgentApps } from '../../../src/agent-apps/engine.ts'
import type { AppRegistry } from '../../../src/apps/registry.ts'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { Conversations } from '../../../src/chats/service.ts'
import { RoutineRuns } from '../../../src/routines/service.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { Apps } from '../../../src/apps/service.ts'
import { HomeService } from '../../../src/home/service.ts'
import { OwnerAdmissionLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { delegationServices } from '../../../src/layers/delegation.ts'
import { KeyedLock } from '../../../src/observability/lock.ts'
import { Changes, makeChanges } from '../../../src/runtime/changes.ts'
import { WorkspaceFeed } from '../../../src/workspace/feed.ts'
import { McpConnections, Resident } from '../../../src/mcp/service.ts'
import { FlowEvents } from '../../../src/observability/flows.ts'
import { OrganizeHandlers } from '../../../src/organize/api.ts'
import { PersonasHandlers } from '../../../src/personas/api.ts'
import { OrganizeReceipts } from '../../../src/organize/receipts.ts'
import { PersonaRegistry } from '../../../src/personas/registry.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { TopicsHandlers } from '../../../src/topics/api.ts'
import { TopicRegistry } from '../../../src/topics/registry.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { currentResident } from '../../fixed-services.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** Lane D's groups only, behind the real gate, router and failure rendering (the pattern of owner-http.test.ts). */
const API = ownerApiOf(TopicsGroup, PersonasGroup, OrganizeGroup)
const LAYER = HttpApiBuilder.layer(API).pipe(
  Layer.provide([TopicsHandlers, PersonasHandlers, OrganizeHandlers]),
  Layer.provide(OwnerAdmissionLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/**
 * The organizing groups (topics, personas, organize) as the agent serves them: lane D's services over real Topic,
 * Persona, receipt and Home stores on SQLite. The gate's plan and resident authority are the only fakes. Nothing here
 * has an open chat to stop, an agent app or an MCP App, so Pi, Stop, the apps and the MCP host are never read.
 */
export const organizing = (options: { readonly active?: boolean } = {}) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  let sessions = 100
  const topics = new TopicRegistry(db, {
    open: async () => String(sessions++),
    register: (chat, topic, name, now) =>
      void db
        .insert(appConversations)
        .values({
          chatId: chat,
          piSession: chat,
          kind: 'main',
          role: 'conversation',
          title: name,
          topicId: topic,
          createdAt: now,
        })
        .run(),
    activate: async () => undefined,
    seed: async () => undefined,
    retitle: () => undefined,
  })
  const personas = new PersonaRegistry(db, ['model-a', 'model-b'])
  const receipts = new OrganizeReceipts(
    db,
    (kind, target) => (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision,
  )
  // SAFETY: with no agent apps, Home reads only the engine's (empty) app list and never an App placement or its info.
  const engine = Object.assign(Object.create(null) as AgentApps, { store: { apps: () => [] } })
  // SAFETY: as above, nothing here places an App, so the App registry is never read.
  const home = new HomeService(db, Object.create(null) as AppRegistry, engine)
  // Current, counting the gate's renewals; the organizing programs ask it only to `require` itself.
  const resident = currentResident()
  const plan = Effect.succeed({ ...PLAN, active: options.active ?? true })
  const plans: EntitlementPolicy = {
    state: () => plan,
    require: () =>
      Effect.flatMap(plan, (current) =>
        current.active ? Effect.succeed(current) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
      ),
  }
  // SAFETY: what only a Stop of an open chat or an App on Home reads, which no request here reaches.
  const unread = undefined as never
  // SAFETY: a Topic created here has no open chat, so an archive (an Undo of its creation) reads only `openIn`.
  const conversations = Object.assign(Object.create(null) as Conversations['Service'], {
    openIn: () => Effect.succeed([]),
  })
  const flows: FlowEvent[] = []
  // The feed reads its sources only for a listener, and none listens here.
  const feed = new WorkspaceFeed(
    unread,
    { conversations: unread, apps: unread, home, topics, personas, invocations: unread, receipts },
    unread,
  )
  const lane = delegationServices({ topics, personas, invocations: unread, receipts, home, feed }).pipe(
    Layer.provide(Layer.merge(KeyedLock.layer, Layer.succeed(Changes, makeChanges()))),
  )
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(API, LAYER).pipe(
      Layer.provide(
        Layer.mergeAll(
          lane,
          Layer.succeed(Conversations, conversations),
          Layer.succeed(AgentInput, unread),
          Layer.succeed(RoutineRuns, unread),
          Layer.succeed(Apps, unread),
          Layer.succeed(McpConnections, unread),
          Layer.succeed(Resident, resident.service),
          Layer.succeed(Entitlements, plans),
          FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  const handle = (request: Request) => runtime.runPromise(OwnerHttp.use((http) => http.handle(request)))
  /** The agent's answer, or a failure if the server passed the request on. */
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await handle(request), () => new Error(`not an API route: ${request.url}`))
  return { fetch, resident, topics, personas, receipts, home, flows }
}

/** A JSON request to the agent's owner API. */
export const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
