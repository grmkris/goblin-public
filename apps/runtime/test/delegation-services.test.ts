import type { Harness, TaskGraphWatch } from '@earendil-works/pi-durable'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentApps } from '../src/agent-apps/engine.ts'
import { Apps } from '../src/apps/service.ts'
import type { ChatId } from '../src/chats/directory.ts'
import { Chats, Conversations } from '../src/chats/service.ts'
import { Home, HomeService } from '../src/home/service.ts'
import { delegationServices } from '../src/layers/delegation.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { OrganizeReceipts } from '../src/organize/receipts.ts'
import { Receipts } from '../src/organize/service.ts'
import { PersonaInvocations } from '../src/personas/invocations.ts'
import { PersonaRegistry } from '../src/personas/registry.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { appConversations } from '../src/storage/schema.ts'
import { TopicRegistry } from '../src/topics/registry.ts'
import { Topics } from '../src/topics/service.ts'
import { WorkspaceLive } from '../src/workspace/live.ts'
import { Workspace, type WorkspaceEvent } from '../src/workspace/service.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * The delegation services over their stores on real SQLite, as the agent's layer builds them, with one lock and one
 * change bus, and the workspace feed over them. The feed's Pi task graph is empty, and the conversations, Apps and
 * chats it reads are fakes with none; `watching` counts the task graph watches running.
 */
const services = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  const topics = new TopicRegistry(db, {
    open: async () => '100',
    register: () => undefined,
    activate: async () => undefined,
    seed: async () => undefined,
    retitle: () => undefined,
  })
  const personas = new PersonaRegistry(db, ['model-a'])
  const invocations = new PersonaInvocations(db)
  const receipts = new OrganizeReceipts(db, () => undefined)
  // SAFETY: with no agent apps, Home reads only the engine's (empty) app list.
  const engine = Object.assign(Object.create(null) as AgentApps, { store: { apps: () => [] } })
  const home = new HomeService(db, engine)
  const watching = { count: 0 }
  // SAFETY: the feed reads the watch's first graph, starts it and stops it; the graph stays empty.
  const watch = Object.assign(Object.create(null) as TaskGraphWatch, {
    value: { tasks: {} },
    start: () => undefined,
    stop: async () => void (watching.count -= 1),
  })
  // SAFETY: the feed asks Pi only to watch its task graph.
  const pi = Object.assign(Object.create(null) as Harness, {
    watchTaskGraph: async () => {
      watching.count += 1
      return watch
    },
  })
  const lane = delegationServices({ topics, personas, invocations, receipts, home }).pipe(
    Layer.provideMerge(Layer.merge(KeyedLock.layer, Layer.succeed(Changes, makeChanges()))),
  )
  const sources = Layer.mergeAll(
    // SAFETY: Personal's chat id, as the chat directory brands it.
    stub(Chats, { primary: '1' as ChatId, isHidden: () => Effect.succeed(false) }),
    stub(Conversations, { list: Effect.succeed([]) }),
    stub(Apps, { list: Effect.succeed([]) }),
    stub(PiSessions, { pi: Effect.succeed(pi) }),
  )
  const layer = Layer.provideMerge(WorkspaceLive, Layer.merge(lane, sources))
  return { layer, watching }
}

const scout = {
  name: 'Scout',
  avatar: { glyph: 'S', hue: 120 },
  role: 'Finds things out',
  instructions: 'Be brief.',
  exclusions: [],
}

describe("lane D's services over their stores", () => {
  it('answers what the stores hold, and their refusals as typed failures', async () => {
    const program = Effect.gen(function* () {
      const topics = yield* Topics
      const personas = yield* Personas
      const invocations = yield* Invocations
      const receipts = yield* Receipts
      const home = yield* Home
      return {
        topics: (yield* topics.list).map((topic) => topic.name),
        missingTopic: yield* Effect.flip(topics.get(99)),
        made: yield* personas.create({ ...scout, operationId: 'op-1' }, 'owner'),
        named: yield* personas.byName('scout'),
        stale: yield* Effect.flip(personas.update(1, { role: 'x', expectedRevision: 9 }, 'owner')),
        changed: yield* personas.update(1, { role: 'Digs', expectedRevision: 1 }, 'owner'),
        offers: yield* personas.offers('model-b'),
        invocation: yield* invocations.get('op-1', 1),
        receipts: yield* receipts.list(),
        missingReceipt: yield* Effect.flip(receipts.get('org_none')),
        home: yield* home.read,
      }
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(services().layer)))
    expect(result.topics).toEqual(['Personal'])
    expect(result.missingTopic).toMatchObject({ _tag: 'NotFound', what: 'topic' })
    expect(result.made).toMatchObject({ created: true, persona: { id: 1, revision: 1 } })
    expect(Option.getOrUndefined(result.named)).toMatchObject({ id: 1, name: 'Scout' })
    expect(result.stale).toMatchObject({ _tag: 'Conflict', reason: 'revision' })
    expect(result.changed).toMatchObject({ before: { role: scout.role, revision: 1 }, after: { role: 'Digs' } })
    expect(result.offers).toBe(false)
    expect(Option.isNone(result.invocation)).toBe(true)
    expect(result.receipts).toEqual([])
    expect(result.missingReceipt).toMatchObject({ _tag: 'NotFound', what: 'receipt' })
    expect(result.home).toEqual({ layout: { revision: 0, tiles: [] }, apps: [] })
  })

  it('tells the workspace feed what each write changed, each as it is now, after its snapshot', async () => {
    const { layer, watching } = services()
    const program = Effect.gen(function* () {
      const opened = yield* Deferred.make<number>()
      const feed = yield* (yield* Workspace).stream.pipe(
        Stream.tap(() => Deferred.succeed(opened, watching.count)),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      )
      const watchedWhileOpen = yield* Deferred.await(opened)
      const made = yield* (yield* Topics).create({ name: 'Garden', operationId: 'op-1' }, 'owner')
      yield* (yield* Personas).create({ ...scout, operationId: 'op-2' }, 'owner')
      const receipt = yield* (yield* Receipts).record({
        kind: 'topic.create',
        target: String(made.topic.id),
        summary: 'Created topic "Garden"',
        actor: 'owner',
        before: null,
        after: { name: 'Garden' },
        afterRevision: 1,
      })
      yield* (yield* Home).edit(
        {
          operationId: 'home-1',
          expectedRevision: 0,
          ops: [{ kind: 'add', tile: { kind: 'note', id: 'n', size: 'small', title: 'N', markdown: '' } }],
        },
        'owner',
      )
      const events: readonly WorkspaceEvent[] = yield* Fiber.join(feed)
      return { topic: made.topic.id, receipt: receipt.id, events, watchedWhileOpen }
    })
    const made = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(made.watchedWhileOpen).toBe(1)
    expect(watching.count).toBe(0)
    const [snapshot, ...rest] = made.events
    expect(snapshot).toMatchObject({ event: 'snapshot', data: { primary: '1', topics: [{ name: 'Personal' }] } })
    const changes = rest.flatMap((event) => (event.event === 'change' ? event.data : []))
    expect(changes).toEqual([
      expect.objectContaining({ type: 'topic', topic: expect.objectContaining({ id: made.topic, name: 'Garden' }) }),
      expect.objectContaining({ type: 'persona', persona: expect.objectContaining({ name: 'Scout' }) }),
      expect.objectContaining({ type: 'receipt', receipt: expect.objectContaining({ id: made.receipt }) }),
      expect.objectContaining({ type: 'home', home: expect.objectContaining({ revision: 1 }) }),
    ])
  })

  it('watches the task graph only while a stream is open, and its snapshot shows what was written before', async () => {
    const { layer, watching } = services()
    const program = Effect.gen(function* () {
      yield* (yield* Personas).create({ ...scout, operationId: 'op-3' }, 'owner')
      const [snapshot] = yield* (yield* Workspace).stream.pipe(Stream.take(1), Stream.runCollect)
      return snapshot
    })
    const snapshot = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(snapshot).toMatchObject({ event: 'snapshot', data: { personas: [{ name: 'Scout' }] } })
    expect(watching.count).toBe(0)
  })
})
