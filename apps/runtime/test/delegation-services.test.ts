import type { WorkspaceChange } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentApps } from '../src/agent-apps/engine.ts'
import type { AppRegistry } from '../src/apps/registry.ts'
import type { ChatDirectory } from '../src/chats/directory.ts'
import type { ConversationRegistry } from '../src/conversations.ts'
import { Home, HomeService } from '../src/home/service.ts'
import { delegationServices } from '../src/layers/delegation.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { OrganizeReceipts } from '../src/organize/receipts.ts'
import { Receipts } from '../src/organize/service.ts'
import { PersonaInvocations } from '../src/personas/invocations.ts'
import { PersonaRegistry } from '../src/personas/registry.ts'
import { Invocations, Personas } from '../src/personas/service.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { appConversations } from '../src/storage/schema.ts'
import { TopicRegistry } from '../src/topics/registry.ts'
import { Topics } from '../src/topics/service.ts'
import { WorkspaceFeed } from '../src/workspace/feed.ts'
import { chatDatabase } from './chats-sqlite.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** A listener set a fake source offers, which nothing here fires. */
const quiet = () => () => undefined

/**
 * Lane D's services over their stores on real SQLite, as the agent's layer builds them, with one lock and one change
 * bus. The feed's Pi task graph is empty, and the conversations, Apps and chats it reads are fakes with none.
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
  // SAFETY: nothing here places an App; the feed reads only the (empty) App list and its listeners.
  const apps = Object.assign(Object.create(null) as AppRegistry, { list: () => [], onChange: quiet, onRemove: quiet })
  const home = new HomeService(db, apps, engine)
  // SAFETY: the feed reads only the conversation list and its listener; there are no conversations here.
  const conversations = Object.assign(Object.create(null) as ConversationRegistry, {
    list: async () => [],
    onChange: quiet,
  })
  // SAFETY: the feed reads only Personal's chat id; the empty task graph names no session.
  const chats = Object.assign(Object.create(null) as ChatDirectory, { primary: () => '1' })
  const watch = { value: { tasks: {} }, start: () => undefined, stop: async () => undefined }
  // SAFETY: the feed asks Pi only to watch its task graph, which stays empty.
  const harness = Object.assign(Object.create(null) as PiHarness, {
    pi: async () => ({ watchTaskGraph: async () => watch }),
  })
  const feed = new WorkspaceFeed(harness, { conversations, apps, home, topics, personas, invocations, receipts }, chats)
  const layer = delegationServices({ topics, personas, invocations, receipts, home, feed }).pipe(
    Layer.provide(Layer.merge(KeyedLock.layer, Layer.succeed(Changes, makeChanges()))),
  )
  return { layer, feed }
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

  it('tells the workspace feed what each write changed, each as it is now', async () => {
    const { layer, feed } = services()
    const sent: { readonly event: string; readonly data: unknown }[] = []
    const close = await feed.open((event, data) => void sent.push({ event, data }))
    const program = Effect.gen(function* () {
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
      return { topic: made.topic.id, receipt: receipt.id }
    })
    const made = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    await close()
    expect(sent[0]?.event).toBe('snapshot')
    // SAFETY: every frame after the snapshot is a `change` frame, a batch of WorkspaceChange.
    const changes = sent.slice(1).flatMap(({ data }) => data as readonly WorkspaceChange[])
    expect(changes.map((change) => change.type)).toEqual(['topic', 'persona', 'receipt', 'home'])
    expect(changes).toEqual([
      expect.objectContaining({ topic: expect.objectContaining({ id: made.topic, name: 'Garden' }) }),
      expect.objectContaining({ persona: expect.objectContaining({ name: 'Scout' }) }),
      expect.objectContaining({ receipt: expect.objectContaining({ id: made.receipt }) }),
      expect.objectContaining({ home: expect.objectContaining({ revision: 1 }) }),
    ])
  })
})
