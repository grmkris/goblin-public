import { SubscriptionRequired } from '@goblin/contracts/api'
import { TopicView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { StopRuntime } from '../../../src/agent-program.ts'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { OrganizeReceipts } from '../../../src/organize/receipts.ts'
import { ResidentAuthority } from '../../../src/resident.ts'
import { Conversations, Invocations, Receipts, Resident, RoutineRuns, Topics } from '../../../src/services.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { TopicRegistry } from '../../../src/topics/registry.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
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

/** Resident authority that only counts renewals: the gate renews it on every admitted request. */
class CountingResident extends ResidentAuthority {
  readonly renewals: number[] = []
  constructor() {
    // SAFETY: `renew` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override renew(now: number): void {
    this.renewals.push(now)
  }
}

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/**
 * The owner API as the agent serves it, over real Topic and receipt stores on SQLite: the gate's plan and resident
 * authority are the only fakes. No request here archives a Topic with open chats, so neither the conversation registry
 * nor anything a Stop reaches is ever read.
 */
const fixture = (options: { readonly active?: boolean } = {}) => {
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
  const receipts = new OrganizeReceipts(db, (_kind, target) => topics.get(Number(target)).revision)
  const resident = new CountingResident()
  const plan = Effect.succeed({ ...PLAN, active: options.active ?? true })
  const plans: EntitlementPolicy = {
    state: () => plan,
    require: () =>
      Effect.flatMap(plan, (current) =>
        current.active ? Effect.succeed(current) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
      ),
  }
  // SAFETY: see the fixture's comment: only an archive of a Topic with open chats reads these.
  const unread = undefined as never
  const stopping = (): StopRuntime => unread
  const runtime = ManagedRuntime.make(
    OwnerHttp.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Topics, topics),
          Layer.succeed(Receipts, receipts),
          Layer.succeed(Conversations, unread),
          Layer.succeed(RoutineRuns, unread),
          Layer.succeed(Invocations, unread),
          Layer.succeed(Resident, resident),
          Layer.succeed(Entitlements, plans),
          // SAFETY: the Topics handlers read only `stopping` from the instance input; the rest stays unused here.
          Layer.succeed(AgentInput, { stopping } as AgentInputs),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  const handle = (request: Request) => runtime.runPromise(OwnerHttp.use((http) => http.handle(request)))
  /** The agent's answer, or a failure if the server passed the request on. */
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await handle(request), () => new Error(`not an API route: ${request.url}`))
  return { handle, fetch, resident, topics }
}

const json = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('the owner API served by the agent', () => {
  it('creates a Topic with 201 and the API headers, quoting the edge reference', async () => {
    const { fetch, resident } = fixture()
    const response = await fetch(
      json(
        'POST',
        '/api/topics',
        { name: ' Garden ', operationId: 'op-1' },
        { 'x-goblin-ref': '8c1f2a3b4d5e6f70-AMS' },
      ),
    )
    expect(response.status).toBe(201)
    expect(Schema.decodeUnknownSync(TopicView)(await response.json())).toMatchObject({ name: 'Garden', revision: 1 })
    expect(response.headers.get('x-goblin-ref')).toBe('8c1f2a3b4d5e6f70-AMS')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resident.renewals).toHaveLength(1)
  })

  it('answers a name clash with the 409 envelope carrying the reference', async () => {
    const { fetch } = fixture()
    await fetch(json('POST', '/api/topics', { name: 'Garden', operationId: 'op-1' }))
    const response = await fetch(
      json('POST', '/api/topics', { name: 'garden', operationId: 'op-2' }, { 'x-goblin-ref': 'ref-409' }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: {
        code: 'conflict',
        message: 'That clashes with something that is already there.',
        recovery: 'Refresh and try again.',
        reason: 'topic_name_taken',
        ref: 'ref-409',
      },
    })
  })

  it('answers a body that does not decode as 400 invalid_input, and a path id that does not parse as 404', async () => {
    const { fetch, resident } = fixture()
    for (const body of [{ name: '', operationId: 'op-1' }, '{not json', { operationId: 'op-1' }]) {
      const response = await fetch(json('POST', '/api/topics', body, { 'x-goblin-ref': 'ref-400' }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_input', ref: 'ref-400' } })
    }
    const unsupported = await fetch(
      new Request('https://agent/api/topics', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    )
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'body is not JSON' } })
    const badId = await fetch(json('PATCH', '/api/topics/0', { name: 'x' }))
    expect(badId.status).toBe(404)
    expect(await badId.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    // The gate admits before the body is decoded, exactly as it ran before every owner RPC method.
    expect(resident.renewals).toHaveLength(5)
  })

  it('refuses to archive Personal (400) and lists the Topics', async () => {
    const { fetch } = fixture()
    const archive = await fetch(json('PATCH', '/api/topics/1', { archived: true }))
    expect(archive.status).toBe(400)
    expect(await archive.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'personal_topic' } })
    const list = await fetch(new Request('https://agent/api/topics'))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([expect.objectContaining({ id: 1, name: 'Personal', personal: true })])
  })

  it('answers 402 subscription_required from the gate before any handler runs', async () => {
    const { fetch, resident } = fixture({ active: false })
    const response = await fetch(new Request('https://agent/api/topics', { headers: { 'x-goblin-ref': 'ref-402' } }))
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({
      error: { code: 'subscription_required', subscribe: '/subscribe', ref: 'ref-402' },
    })
    expect(resident.renewals).toEqual([])
  })

  it('passes every path that is not an owner endpoint back to the raw routes', async () => {
    const { handle } = fixture()
    for (const request of [
      new Request('https://agent/home'),
      new Request('https://agent/conversations/1/snapshot'),
      new Request('https://agent/api/unknown'),
      new Request('https://agent/api/topics', { method: 'DELETE' }),
    ])
      expect(Option.isNone(await handle(request))).toBe(true)
  })

  it("serves the probes' typed client: a clash decodes as the Conflict class with its reference", async () => {
    const { fetch } = fixture()
    const agent = { fetch }
    const made = await callOwner(agent, (api) => api.topics.create({ payload: { name: 'Work', operationId: 'op-1' } }))
    expect(made).toMatchObject({ name: 'Work' })
    const clash = await callOwner(agent, (api) =>
      Effect.flip(api.topics.create({ payload: { name: 'work', operationId: 'op-2' } })),
    )
    expect(clash).toMatchObject({ _tag: 'Conflict', reason: 'topic_name_taken', ref: 'integration-probe' })
    const renamed = await callOwner(agent, (api) =>
      api.topics.update({ params: { id: made.id }, payload: { name: 'Work 2' } }),
    )
    expect(renamed).toMatchObject({ id: made.id, name: 'Work 2', revision: 2 })
  })
})
