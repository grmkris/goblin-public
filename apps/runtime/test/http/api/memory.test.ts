import { MemoryStatus } from '@goblin/contracts'
import { MemoryGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import { ChatDirectory } from '../../../src/chats/directory.ts'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { MemoryHandlers } from '../../../src/memory/api.ts'
import { ChatMemories } from '../../../src/memory/memory.ts'
import { ResidentAuthority } from '../../../src/resident.ts'
import { Resident } from '../../../src/services.ts'
import { appChatMemoryLog, appChatMemoryState } from '../../../src/storage/chat-memory.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { appTopics } from '../../../src/storage/topics.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { callOwner } from '../../integration/owner-api.ts'
import { knowledgeOver } from '../../knowledge-layer.ts'

/** Resident authority the gate renews on every admitted request; nothing here reads it back. */
class RenewedResident extends ResidentAuthority {
  constructor() {
    // SAFETY: `renew` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override renew(): void {}
}

const plans: EntitlementPolicy = {
  state: () => Effect.die('the gate only requires the plan'),
  require: () =>
    Effect.succeed({
      active: true,
      source: 'override',
      until: null,
      dailyCredits: 100,
      status: 'active',
      hasCustomer: false,
      cancelAtPeriodEnd: false,
    }),
}

/** Only the memory group, behind the real gate, router and failure rendering (owner-http.test.ts's pattern). */
const MEMORY_API = ownerApiOf(MemoryGroup)
const MEMORY = HttpApiBuilder.layer(MEMORY_API).pipe(
  Layer.provide(MemoryHandlers),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/** `count` remembered messages of `chatId`, from entry 11 on. */
const remembered = (chatId: string, count: number) =>
  Array.from({ length: count }, (_, idx) => ({ chatId, idx, entryId: 11 + idx, kind: 'user' as const }))

/**
 * The memory group as the agent serves it, over real chat and memory tables on SQLite: Personal (`1`, two messages,
 * no view yet), the Garden Topic's Conversation (`70`, three messages, two summarized) and a thread under it (`71`).
 * The Memories service is lane K's layer over the legacy instances; the gate's plan and resident authority are fakes.
 */
const fixture = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  db.insert(appTopics)
    .values({ id: 2, name: 'Garden', chatId: '70', createdBy: 'owner', createdAt: 1, updatedAt: 1 })
    .run()
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 },
      { chatId: '70', piSession: '70', kind: 'main', role: 'conversation', topicId: 2, createdAt: 2 },
      { chatId: '71', piSession: '71', kind: 'thread', parentSession: '70', topicId: 2, createdAt: 3 },
    ])
    .run()
  db.insert(appChatMemoryLog)
    .values([...remembered('1', 2), ...remembered('70', 3)])
    .run()
  db.insert(appChatMemoryState)
    .values([
      { chatId: '1', originEntry: 10, viewThrough: 0 },
      { chatId: '70', originEntry: 10, viewThrough: 2 },
    ])
    .run()
  const chats = new ChatDirectory(db)
  // SAFETY: `status` reads SQLite only; Pi and the model are never called.
  const memories = new ChatMemories({ db, harness: undefined as never, model: undefined as never, chats }, {}, [])
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(MEMORY_API, MEMORY).pipe(
      Layer.provide(
        Layer.mergeAll(
          knowledgeOver({ memories, chats }),
          Layer.succeed(Resident, new RenewedResident()),
          Layer.succeed(Entitlements, plans),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(
      await runtime.runPromise(OwnerHttp.use((http) => http.handle(request))),
      () => new Error(`not an API route: ${request.url}`),
    )
  return { fetch }
}

const status = (path: string) =>
  new Request(`https://agent/api/agent/memory${path}`, { headers: { 'x-goblin-ref': 'r' } })

describe('the memory group', () => {
  it("answers Personal's memory without a chat, and a thread's from the Conversation it sits under", async () => {
    const { fetch } = fixture()
    const answers = await Promise.all(['', '?chat=1', '?chat=70', '?chat=71'].map((path) => fetch(status(path))))
    expect(answers.map((response) => response.status)).toEqual([200, 200, 200, 200])
    const bodies = await Promise.all(
      answers.map(async (response) => Schema.decodeUnknownSync(MemoryStatus)(await response.json())),
    )
    expect(bodies).toEqual([
      { messages: 2, summarized: 0 },
      { messages: 2, summarized: 0 },
      { messages: 3, summarized: 2 },
      { messages: 3, summarized: 2 },
    ])
  })

  it('answers an unknown chat 404 and a chat that is no chat id 400, quoting the reference', async () => {
    const { fetch } = fixture()
    const missing = await fetch(status('?chat=999'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found', what: 'chat', ref: 'r' } })
    for (const chat of ['abc', '1234567890123', '']) {
      const invalid = await fetch(status(`?chat=${chat}`))
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input', ref: 'r' } })
    }
  })

  it("serves the probes' typed client", async () => {
    const agent = fixture()
    expect(await callOwner(agent, (api) => api.memory.status({ query: {} }))).toEqual({ messages: 2, summarized: 0 })
    expect(await callOwner(agent, (api) => api.memory.status({ query: { chat: '71' } }))).toEqual({
      messages: 3,
      summarized: 2,
    })
    const missing = await callOwner(agent, (api) => Effect.flip(api.memory.status({ query: { chat: '999' } })))
    expect(missing).toMatchObject({ _tag: 'NotFound', what: 'chat', ref: 'integration-probe' })
  })
})
