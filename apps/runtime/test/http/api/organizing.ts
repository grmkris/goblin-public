import {
  HomeGroup,
  OrganizeGroup,
  PersonasGroup,
  SubscriptionRequired,
  TopicsGroup,
  ownerApiOf,
} from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach } from 'vitest'
import type { StopRuntime } from '../../../src/agent-program.ts'
import type { AgentApps } from '../../../src/agent-apps/engine.ts'
import type { AppRegistry } from '../../../src/apps/registry.ts'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { ConversationRegistry } from '../../../src/conversations.ts'
import { HomeHandlers } from '../../../src/home/api.ts'
import { HomeService } from '../../../src/home/service.ts'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { OrganizeHandlers } from '../../../src/organize/api.ts'
import { PersonasHandlers } from '../../../src/personas/api.ts'
import { OrganizeReceipts } from '../../../src/organize/receipts.ts'
import { PersonaRegistry } from '../../../src/personas/registry.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import * as Legacy from '../../../src/services.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { TopicsHandlers } from '../../../src/topics/api.ts'
import { TopicRegistry } from '../../../src/topics/registry.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { ActiveResident } from '../../fixed-services.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** Resident authority that is current and counts the gate's renewals. */
class OwnerResident extends ActiveResident {
  readonly renewals: number[] = []
  override renew(now: number): void {
    this.renewals.push(now)
  }
}

/** Lane D's groups only, behind the real gate, router and failure rendering (the pattern of owner-http.test.ts). */
const API = ownerApiOf(TopicsGroup, PersonasGroup, OrganizeGroup, HomeGroup)
const LAYER = HttpApiBuilder.layer(API).pipe(
  Layer.provide([TopicsHandlers, PersonasHandlers, OrganizeHandlers, HomeHandlers]),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/**
 * The organizing groups (topics, personas, organize, home) as the agent serves them, over real Topic, Persona, receipt
 * and Home stores on SQLite. The gate's plan and resident authority are the only fakes. Nothing here has an open chat
 * to stop, an agent app or an MCP App, so Pi, what a Stop reaches, the apps and the MCP host are never read.
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
  const resident = new OwnerResident()
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
  // SAFETY: an archive of a Topic with open chats is the only thing that reads what a Stop reaches; none has any here.
  const stopping = (): StopRuntime => unread
  // SAFETY: a Topic created here has no open chat, so an archive (an Undo of its creation) reads only `openIn`.
  const conversations = Object.assign(Object.create(ConversationRegistry.prototype) as ConversationRegistry, {
    openIn: () => [],
  })
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(API, LAYER).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Legacy.Topics, topics),
          Layer.succeed(Legacy.Personas, personas),
          Layer.succeed(Legacy.Receipts, receipts),
          Layer.succeed(Legacy.Home, home),
          Layer.succeed(Legacy.Conversations, conversations),
          Layer.succeed(Legacy.Resident, resident),
          Layer.succeed(Entitlements, plans),
          // SAFETY: the organizing handlers read only `stopping` from the instance input.
          Layer.succeed(AgentInput, { stopping } as AgentInputs),
          Layer.succeed(Legacy.RoutineRuns, unread),
          Layer.succeed(Legacy.Invocations, unread),
          Layer.succeed(Legacy.Apps, unread),
          Layer.succeed(Legacy.Mcp, unread),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  const handle = (request: Request) => runtime.runPromise(OwnerHttp.use((http) => http.handle(request)))
  /** The agent's answer, or a failure if the server passed the request on. */
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await handle(request), () => new Error(`not an API route: ${request.url}`))
  return { fetch, resident, topics, personas, receipts, home }
}

/** A JSON request to the agent's owner API. */
export const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
