import { ConversationView } from '@goblin/contracts'
import { ConversationsGroup, InvalidInput, NotFound, ownerApiOf } from '@goblin/contracts/api'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppRegistry } from '../../../src/apps/registry.ts'
import type { ModelBudget } from '../../../src/budget.ts'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { type CapabilityProfiles, scopeOf } from '../../../src/capabilities/profiles.ts'
import { ConversationsHandlers } from '../../../src/chats/api.ts'
import { ChatDirectory } from '../../../src/chats/directory.ts'
import type { ChatMover } from '../../../src/chats/mover.ts'
import type { ConversationRegistry } from '../../../src/conversations.ts'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import type { FileStore } from '../../../src/files/store.ts'
import type { McpHost } from '../../../src/mcp/host.ts'
import type { PersonaInvocations } from '../../../src/personas/invocations.ts'
import type { PersonaRegistry } from '../../../src/personas/registry.ts'
import type { PersonaView } from '@goblin/contracts'
import { ResidentAuthority } from '../../../src/resident.ts'
import type { ChatRetrieval } from '../../../src/retrieval/service.ts'
import type { PersonaTurnKit } from '../../../src/organize/kit.ts'
import type { RoutineController } from '../../../src/routines/controller.ts'
import type { RoutineRunStore } from '../../../src/routines/runs.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import { Apps, Budget, Capabilities, Chats, Conversations, Files, Invocations, Mcp } from '../../../src/services.ts'
import { Moves, Personas, Resident, Retrieval, RoutineRuns, Skills } from '../../../src/services.ts'
import type { SkillLibrary } from '../../../src/skills/library.ts'
import { appChatOperations, appConversations } from '../../../src/storage/schema.ts'
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

/** A stand-in implementing only the members a request here reaches; reaching any other fails the test loudly. */
const fake = <T>(members: Partial<T>): T =>
  // SAFETY: every fake below is built through this one cast, and each is given every member its programs call.
  members as T

/** Resident authority that is always current and counts the gate's renewals. */
class CountingResident extends ResidentAuthority {
  readonly renewals: number[] = []
  constructor() {
    // SAFETY: `renew` and `require` are overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override renew(now: number): void {
    this.renewals.push(now)
  }
  override require(): void {}
}

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  topic: 1,
  createdAt: 1,
  keepOpen: false,
  replies: 0,
  ...extra,
})

/** The registry's chats: main, an open thread, a closed thread and a subagent. Each chat's Pi session is its id. */
const CHATS: Readonly<Record<string, ConversationView>> = {
  '1': {
    id: '1',
    kind: 'main',
    primary: true,
    conversation: true,
    topic: 1,
    createdAt: 1,
    keepOpen: false,
    replies: 0,
  },
  '2': view('2', { title: 'Plans' }),
  '3': view('3', { closedAt: 5, closedBy: 'owner' }),
  '4': view('4', { kind: 'subagent', title: 'scout', closedBy: 'done', closedAt: 6 }),
}
/** The Thread a create or a Thread start makes. */
const NEW = '9'

/** What the fakes were asked to do, in order. */
type Calls = string[]

const known = (id: string): string => {
  if (CHATS[id] === undefined && id !== NEW) throw new NotFound({ what: 'conversation' })
  return id
}

/** The registry's reads over `CHATS`. */
const registryReads = (): Partial<ConversationRegistry> => ({
  list: async () => Object.values(CHATS),
  require: known,
  requireOpen: (id) => {
    if (CHATS[known(id)]?.closedAt !== undefined) throw new InvalidInput({ reason: 'conversation_closed' })
    return id
  },
  kindOf: (id) => CHATS[known(id)]?.kind ?? 'thread',
  view: async (id) => (id === NEW ? view(NEW, { forkEntry: 3 }) : CHATS[id]),
  subtree: (id) => [id],
  // SAFETY: the handler passes Pi's records through as they are; these stand in for them.
  history: async (id, before) => ({ entries: [{ id: before - 1, kind: 'pi.user', chat: id }] as never, more: true }),
})

/** The registry's writes, recorded; a Thread start registers its Thread in the real directory, as the registry does. */
const registryWrites = (db: ReturnType<typeof chatDatabase>['db'], calls: Calls): Partial<ConversationRegistry> => ({
  create: async (_now, topic) => view(NEW, topic === undefined ? {} : { topic }),
  branch: async (parent, entry) => view(NEW, { parent, forkEntry: entry }),
  update: async (id, change) => ({
    view: view(known(id), change.title === undefined ? {} : { title: change.title }),
    closed: [],
  }),
  markRead: (id) => void calls.push(`read:${known(id)}`),
  startThread: async (parent, operationId) => {
    calls.push(`start:${parent}:${operationId}`)
    db.insert(appConversations)
      .values({ chatId: NEW, piSession: NEW, kind: 'thread', parentSession: parent, createdAt: 2 })
      .onConflictDoNothing()
      .run()
    return view(NEW)
  },
  stopSubagents: async (id) => void calls.push(`subagents:${id}`),
})

/** What reached Pi: owner inputs by session, and passive writes by conversation. */
type PiRecord = {
  readonly submitted: { readonly session: string; readonly operationId: string; readonly content: unknown }[]
  readonly writes: { readonly conversation: number; readonly requestId: string; readonly kind: string }[]
}

/** Pi's harness: it admits every input, holds one queued input and one passive write in each inbox, and aborts. */
const fakeHarness = (record: PiRecord, calls: Calls): PiHarness => {
  const conversation = (id: number) => ({
    submit: async (write: { readonly requestId: string; readonly entry: { readonly kind: string } }) => {
      record.writes.push({ conversation: id, requestId: write.requestId, kind: write.entry.kind })
      return { id: record.writes.length }
    },
  })
  const inbox = {
    items: [
      { id: 7, mode: 'followUp', content: 'later' },
      { id: 8, mode: 'write', content: 'passive' },
    ],
  }
  return fake<PiHarness>({
    submit: async (content, { session = '', operationId = '' } = {}) => {
      record.submitted.push({ session, operationId, content })
      return { session, operationId, accepted: true }
    },
    // SAFETY: the programs under test read only `conversation` and `snapshot` from Pi's own harness.
    pi: async () => ({ conversation: async (id: number) => conversation(id), snapshot: async () => inbox }) as never,
    // SAFETY: a session is asked only for its events (the snapshot) and whether it is busy.
    session: (session) =>
      ({
        events: async () => ({ snapshot: { session, entries: [{ id: 1, kind: 'pi.user' }] }, stop: async () => {} }),
        busy: async () => false,
      }) as never,
    abort: async ({ session = '' } = {}) => {
      calls.push(`abort:${session}`)
      return true
    },
  })
}

/** The other services the conversation programs read: everything allowed, nothing running, only `personas` to tag. */
const services = (calls: Calls, personas: readonly PersonaView[]) =>
  Layer.mergeAll(
    // No message here carries files or App context, so neither store is read.
    Layer.succeed(Files, fake<FileStore>({})),
    Layer.succeed(Apps, fake<AppRegistry>({})),
    Layer.succeed(Budget, fake<ModelBudget>({ require: async () => undefined })),
    Layer.succeed(RoutineRuns, fake<RoutineRunStore>({ session: () => undefined })),
    Layer.succeed(
      Invocations,
      fake<PersonaInvocations>({
        stopChat: (chat) => calls.push(`invocations:${chat}`),
        insert: (asked) => {
          calls.push(`asked:${asked.map(({ persona }) => persona).join(',')}`)
          return []
        },
      }),
    ),
    Layer.succeed(Personas, fake<PersonaRegistry>({ active: () => personas, offers: () => false })),
    Layer.succeed(
      Capabilities,
      fake<CapabilityProfiles>({ scope: () => scopeOf([], true), own: () => [], inherited: () => [] }),
    ),
    Layer.succeed(Mcp, fake<McpHost>({ servers: () => [], grants: () => [] })),
    Layer.succeed(
      Skills,
      fake<SkillLibrary>({ catalog: async () => ({ skills: [], unavailable: [] }), sources: () => [] }),
    ),
    Layer.succeed(
      Moves,
      fake<ChatMover>({
        move: async (chat, input) => ({ ...input, chat, mode: 'settled', state: 'settled', thread: NEW }),
      }),
    ),
    // SAFETY: the sources handler reads only the index's `uses`.
    Layer.succeed(Retrieval, fake<ChatRetrieval>({ index: { uses: () => [] } as never })),
  )

/** The bridge: here it only puts a session on the owner's model, and nothing reads what that returns. */
const run = async () =>
  // SAFETY: as above, no caller reads the value.
  undefined as never

/** The instance's pieces the handlers read: Pi, the model choices, no routine answers, the Personas and the bridge. */
const instance = (harness: PiHarness, calls: Calls) => {
  const routines = fake<RoutineController>({ answer: async () => false, stop: async () => undefined })
  const personas = fake<PersonaTurnKit>({
    drop: async () => calls.push('personas:drop'),
    start: async (_pi, ask) => void calls.push(`personas:${ask.order}`),
  })
  const stopping = () => ({ harness, routines, personas })
  return fake<AgentInputs>({ harness, applied: new Map(), routines, personas, run, stopping })
}

/** Only the conversations group, behind the real gate, router and failure rendering. */
const CONVERSATIONS_API = ownerApiOf(ConversationsGroup)
const CONVERSATIONS = HttpApiBuilder.layer(CONVERSATIONS_API).pipe(
  Layer.provide(ConversationsHandlers),
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
 * The conversations group as the agent serves it, running the conversation programs over a real chat directory on
 * SQLite. The registry, Pi and the instance are fakes that record what the programs asked of them.
 */
const fixture = (options: { readonly personas?: readonly PersonaView[] } = {}) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const chats = Object.values(CHATS).map(({ id, kind, primary }) =>
    primary === true
      ? { chatId: id, piSession: id, kind, role: 'primary' as const, createdAt: 1 }
      : { chatId: id, piSession: id, kind, parentSession: '1', createdAt: 1 },
  )
  db.insert(appConversations).values(chats).run()
  const calls: Calls = []
  const record: PiRecord = { submitted: [], writes: [] }
  const harness = fakeHarness(record, calls)
  const resident = new CountingResident()
  const plan = Effect.succeed(PLAN)
  const plans: EntitlementPolicy = { state: () => plan, require: () => plan }
  const registry = fake<ConversationRegistry>({ ...registryReads(), ...registryWrites(db, calls) })
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(CONVERSATIONS_API, CONVERSATIONS).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Chats, new ChatDirectory(db)),
          Layer.succeed(Conversations, registry),
          services(calls, options.personas ?? []),
          Layer.succeed(Resident, resident),
          Layer.succeed(Entitlements, plans),
          Layer.succeed(AgentInput, instance(harness, calls)),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  const handle = (request: Request) => runtime.runPromise(OwnerHttp.use((http) => http.handle(request)))
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await handle(request), () => new Error(`not an API route: ${request.url}`))
  const operations = () => db.select().from(appChatOperations).all()
  return { fetch, calls, record, resident, operations }
}

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

const decodeViews = Schema.decodeUnknownSync(Schema.Array(ConversationView))

describe('the conversations API served by the agent', () => {
  it('lists the chats and creates a Thread with 201, empty or branched from an entry', async () => {
    const { fetch } = fixture()
    const list = await fetch(json('GET', '/api/conversations'))
    expect(list.status).toBe(200)
    expect(decodeViews(await list.json()).map(({ id }) => id)).toEqual(['1', '2', '3', '4'])
    const empty = await fetch(json('POST', '/api/conversations', { topic: 2 }))
    expect(empty.status).toBe(201)
    expect(await empty.json()).toMatchObject({ id: NEW, topic: 2 })
    const branched = await fetch(json('POST', '/api/conversations', { from: { conversation: '2', entry: 4 } }))
    expect(branched.status).toBe(201)
    expect(await branched.json()).toMatchObject({ id: NEW, parent: '2', forkEntry: 4 })
  })

  it("sends the owner's message with 202 and Pi's receipt, admitted once per operation", async () => {
    const { fetch, record, operations, resident } = fixture()
    const response = await fetch(
      json('POST', '/api/conversations/2/messages', { input: 'hello', operationId: 'op-1' }, { 'x-goblin-ref': 'r-1' }),
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ operationId: 'op-1', session: '2', accepted: true })
    expect(response.headers.get('x-goblin-ref')).toBe('r-1')
    expect(record.submitted).toEqual([{ session: '2', operationId: 'op-1', content: 'hello' }])
    expect(operations()).toEqual([expect.objectContaining({ chatId: '2', operationId: 'op-1', sessionId: '2' })])
    expect(resident.renewals).toHaveLength(1)
  })

  it('refuses an empty or closed send (400), an unknown chat (404) and a path id or body that does not decode', async () => {
    const { fetch, record } = fixture()
    const answers = [
      ['/api/conversations/2/messages', { input: '  ', operationId: 'op-1' }, 400, 'empty_message'],
      ['/api/conversations/3/messages', { input: 'hi', operationId: 'op-2' }, 400, 'conversation_closed'],
      ['/api/conversations/77/messages', { input: 'hi', operationId: 'op-3' }, 404, undefined],
      ['/api/conversations/abc/messages', { input: 'hi', operationId: 'op-4' }, 404, undefined],
      ['/api/conversations/2/messages', { input: 'hi' }, 400, 'body does not match the expected shape'],
    ] as const
    for (const [path, body, status, reason] of answers) {
      const response = await fetch(json('POST', path, body))
      expect(response.status).toBe(status)
      if (reason !== undefined) expect(await response.json()).toMatchObject({ error: { reason } })
    }
    expect(record.submitted).toEqual([])
  })

  it('starts a Thread with 201: the head goes into the chat, the message into the Thread', async () => {
    const { fetch, calls, record } = fixture()
    const response = await fetch(
      json('POST', '/api/conversations/1/threads', { input: 'plan it', operationId: 'op-t' }),
    )
    expect(response.status).toBe(201)
    const started = Schema.decodeUnknownSync(Schema.Struct({ thread: ConversationView, receipt: Schema.Unknown }))(
      await response.json(),
    )
    expect(started.thread).toMatchObject({ id: NEW, forkEntry: 3 })
    expect(started.receipt).toEqual({ operationId: 'op-t', session: NEW, accepted: true })
    expect(calls).toContain('start:1:op-t')
    expect(record.writes).toEqual([{ conversation: 1, requestId: 'thread-head:op-t', kind: 'app.thread_head' }])
    expect(record.submitted).toEqual([{ session: NEW, operationId: 'op-t', content: 'plan it' }])
  })

  it('starts a Thread whose tagged Personas answer there in the order the message asks (H1)', async () => {
    const ada = fake<PersonaView>({
      id: 5,
      name: 'Ada',
      revision: 2,
      role: 'critic',
      instructions: 'Brief.',
      exclusions: [],
    })
    const { fetch, calls, record } = fixture({ personas: [ada] })
    const body = { input: 'compare them', operationId: 'op-p', selections: [{ kind: 'persona', personaId: 5 }] }
    const response = await fetch(json('POST', '/api/conversations/1/threads', { ...body, personaOrder: 'sequence' }))
    expect(response.status).toBe(201)
    expect(calls).toEqual(['start:1:op-p', 'asked:5', 'personas:sequence'])
    expect(record.writes.map(({ conversation, kind }) => [conversation, kind])).toEqual([
      [1, 'app.thread_head'],
      [9, 'app.persona_ask'],
    ])
    expect(record.submitted).toEqual([])
  })

  it('stops a chat, marks it read and renames it', async () => {
    const { fetch, calls } = fixture()
    const stop = await fetch(json('POST', '/api/conversations/2/stop', {}))
    expect(stop.status).toBe(200)
    expect(await stop.json()).toEqual({ stopped: true })
    expect(calls).toEqual(['subagents:2', 'personas:drop', 'invocations:2', 'abort:2'])
    const read = await fetch(json('PUT', '/api/conversations/2/read', {}))
    expect(await read.json()).toEqual({ read: true })
    expect(calls).toContain('read:2')
    const renamed = await fetch(json('PATCH', '/api/conversations/2', { title: 'Trips' }))
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ id: '2', title: 'Trips' })
  })

  it('reads history before an entry, the snapshot and the sources of a registered chat', async () => {
    const { fetch } = fixture()
    const page = await fetch(json('GET', '/api/conversations/2/history?before=10'))
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({ entries: [{ id: 9, kind: 'pi.user', chat: '2' }], more: true })
    for (const query of ['?before=0', '?before=x', '?before=1.5', ''])
      expect((await fetch(json('GET', `/api/conversations/2/history${query}`))).status).toBe(400)
    expect((await fetch(json('GET', '/api/conversations/77/history?before=10'))).status).toBe(404)
    const snapshot = await fetch(json('GET', '/api/conversations/2/snapshot'))
    expect(await snapshot.json()).toEqual({ session: '2', entries: [{ id: 1, kind: 'pi.user' }] })
    expect((await fetch(json('GET', '/api/conversations/77/snapshot'))).status).toBe(404)
    expect(await (await fetch(json('GET', '/api/conversations/2/sources'))).json()).toEqual([])
  })

  it("lists the owner's queued inputs, answers a move's receipt, and reads the composer and switches", async () => {
    const { fetch } = fixture()
    const queue = await fetch(json('GET', '/api/conversations/2/queue'))
    expect(await queue.json()).toEqual({ inputs: [{ id: 7, mode: 'followUp', content: 'later' }] })
    const subagent = await fetch(json('GET', '/api/conversations/4/queue'))
    expect(await subagent.json()).toEqual({ inputs: [] })
    const move = await fetch(json('POST', '/api/conversations/1/move', { entry: 5, operationId: 'move-1' }))
    expect(await move.json()).toEqual({
      operationId: 'move-1',
      chat: '1',
      mode: 'settled',
      state: 'settled',
      thread: NEW,
    })
    const composer = await fetch(json('GET', '/api/conversations/2/composer'))
    expect(await composer.json()).toEqual({
      options: [
        {
          selection: { kind: 'subagent', conversationId: '4' },
          label: 'scout',
          description: 'Done · Reference here',
        },
      ],
      unavailable: [],
    })
    const switches = await fetch(json('GET', '/api/conversations/2/capabilities'))
    expect(await switches.json()).toMatchObject({ thread: '2', kind: 'thread', servers: [], subagents: true })
  })

  it("serves the probes' typed client: a refusal decodes as the InvalidInput class with its reference", async () => {
    const agent = fixture()
    const receipt = await callOwner(agent, (api) =>
      api.conversations.submit({ params: { id: '2' }, payload: { input: 'hi', operationId: 'op-c' } }),
    )
    expect(receipt).toEqual({ operationId: 'op-c', session: '2', accepted: true })
    const refused = await callOwner(agent, (api) =>
      Effect.flip(api.conversations.submit({ params: { id: '3' }, payload: { input: 'hi', operationId: 'op-d' } })),
    )
    expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'conversation_closed', ref: 'integration-probe' })
    const page = await callOwner(agent, (api) =>
      api.conversations.history({ params: { id: '2' }, query: { before: 3 } }),
    )
    expect(page).toEqual({ entries: [{ id: 2, kind: 'pi.user', chat: '2' }], more: true })
  })
})
