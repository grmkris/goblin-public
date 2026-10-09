import { ModelChoice } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import { AgentGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { Applied } from '../../../src/agent-model.ts'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { ModelBudget, UsageStore } from '../../../src/budget.ts'
import { TelegramChannel } from '../../../src/channel/channel.ts'
import { ChatDirectory, registerPrimary } from '../../../src/chats/directory.ts'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { AgentHandlers } from '../../../src/routines/agent-api.ts'
import { ChatsLive } from '../../../src/layers/conversation.ts'
import { ModelBudgetLive, RoutinesLive } from '../../../src/layers/routines.ts'
import { Events, McpConnections, McpGrants, McpServers, Resident } from '../../../src/mcp/service.ts'
import { ModelChoiceStore, ModelPicker, modelOptions } from '../../../src/models.ts'
import { RoutineController } from '../../../src/routines/controller.ts'
import { RoutineUsage } from '../../../src/routines/usage.ts'
import { Db } from '../../../src/runtime/db.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import * as Legacy from '../../../src/services.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { currentResident } from '../../fixed-services.ts'
import { callOwner } from '../../integration/owner-api.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** Only this group, behind the real gate, router and failure rendering. */
const API = ownerApiOf(AgentGroup)
const SERVED = HttpApiBuilder.layer(API).pipe(
  Layer.provide(AgentHandlers),
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
 * The agent group as the agent serves it, over the real budget, model picker, chat directory and Telegram channel on
 * SQLite. Pi is a session that records the model it is put on; the MCP host offers no tools.
 */
const fixture = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const sqlite = db as never
  registerPrimary(db, 1)
  const chats = new ChatDirectory(db)
  const budget = new ModelBudget(new UsageStore(sqlite), 100)
  const models = new ModelPicker(new ModelChoiceStore(sqlite), modelOptions('model-b', 'model-a'))
  // SAFETY: the channel's status and disable read and clear its tables only; the cipher and telemetry stay unused.
  const channel = new TelegramChannel(sqlite, undefined as never, () => undefined, undefined, chats)
  const pinned: string[] = []
  // Choosing a model only puts the primary session on it; nothing else of Pi is reached.
  const harness: PiHarness = Object.assign(Object.create(null), {
    session: (session: string) => ({
      setModel: async ({ id }: { id: string }) => void pinned.push(`${session} ${id}`),
    }),
  })
  const applied: Applied = new Map()
  const plans: EntitlementPolicy = { state: () => Effect.succeed(PLAN), require: () => Effect.succeed(PLAN) }
  const legacy = Layer.mergeAll(
    Layer.succeed(Legacy.Budget, budget),
    Layer.succeed(Legacy.Models, models),
    Layer.succeed(Legacy.Channel, channel),
    Layer.succeed(Legacy.Chats, chats),
    // The channel's tools: the server offers none, so turning the channel on is refused before anything is granted.
    Layer.succeed(McpServers, Object.assign(Object.create(null), { tools: () => Effect.succeed([]) })),
    Layer.succeed(McpConnections, Object.assign(Object.create(null), { snapshot: () => Effect.succeedNone })),
    Layer.succeed(McpGrants, Object.create(null)),
    Layer.succeed(Events, Object.assign(Object.create(null), { activeConsumer: () => Effect.succeedNone })),
    // The lane's other services: RoutinesLive builds their adapters, and nothing here calls them.
    Layer.succeed(Db, sqlite),
    Layer.succeed(Legacy.RoutineUsageProjection, Object.create(RoutineUsage.prototype)),
    Layer.succeed(Resident, currentResident().service),
    Layer.succeed(Entitlements, plans),
    // The agent handlers read only these from the instance input.
    Layer.succeed(
      AgentInput,
      Object.assign(Object.create(null), {
        harness,
        applied,
        routines: Object.create(RoutineController.prototype),
        entitlements: plans,
        env: { APP_URL: 'https://goblin.test', CREDENTIAL_KEY: 'unused', MODELS: 'model-b', MODEL_ID: 'model-a' },
        userId: 'owner',
        schedulePull: async () => undefined,
      }),
    ),
  )
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(API, SERVED).pipe(
      Layer.provide(Layer.provideMerge(Layer.mergeAll(ModelBudgetLive, RoutinesLive, ChatsLive), legacy)),
    ),
  )
  runtimes.push(runtime)
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await runtime.runPromise(OwnerHttp.use((http) => http.handle(request))), () =>
      Error(`not an API route: ${request.url}`),
    )
  return { fetch, budget, pinned, applied }
}

const send = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

describe('the agent group served by the agent', () => {
  it("answers today's usage in Credits against the plan's allowance", async () => {
    const { fetch, budget } = fixture()
    budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, Math.floor(Date.now() / 1000))
    const response = await fetch(send('GET', '/api/agent/usage'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ used: 1, limit: 100 })
  })

  it('reads the model choice, moves main to a pick at once, and refuses a model not on offer', async () => {
    const { fetch, pinned, applied } = fixture()
    const choice = Schema.decodeUnknownSync(ModelChoice)(await (await fetch(send('GET', '/api/agent/model'))).json())
    expect(choice).toMatchObject({ current: 'model-a', default: 'model-a' })
    expect(choice.options.map((option) => option.id)).toEqual(['model-a', 'model-b'])
    const picked = await callOwner({ fetch }, (api) => api.agent.chooseModel({ payload: { model: 'model-b' } }))
    expect(picked.current).toBe('model-b')
    expect(pinned).toEqual([`${[...applied.keys()].join()} model-b`])
    const refused = await fetch(send('PUT', '/api/agent/model', { model: 'not-offered' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'model' } })
    const empty = await fetch(send('PUT', '/api/agent/model', { model: '' }))
    expect(empty.status).toBe(400)
  })

  it('answers the channel as null while off, refuses a connection without its tools, and turns it off', async () => {
    const { fetch } = fixture()
    const status = await fetch(send('GET', '/api/agent/channel'))
    expect(status.status).toBe(200)
    expect(await status.text()).toBe('null')
    const refused = await fetch(send('PUT', '/api/agent/channel', { serverId: 'myagent' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_input', reason: 'myagent does not offer inbox, send_message, subscribe, unsubscribe' },
    })
    const off = await fetch(send('DELETE', '/api/agent/channel'))
    expect(off.status).toBe(200)
    expect(await off.text()).toBe('null')
    expect(await callOwner({ fetch }, (api) => api.agent.channel())).toBeNull()
  })
})
