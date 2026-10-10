import { EVERYTHING } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyedLock } from '../src/observability/lock.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { appConversations } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { TopicRegistry } from '../src/topics/registry.ts'
import { Topics } from '../src/topics/service.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** A registry over the real schema whose Pi side is a counter: each `open` is one new Pi session. */
const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  const opened: string[] = []
  const retitled: string[] = []
  const activated: string[] = []
  const seeded: string[] = []
  const touched: string[] = []
  let gate: Promise<void> = Promise.resolve()
  const topics = new TopicRegistry(db, {
    open: () =>
      Effect.promise(async () => {
        await gate
        const session = String(100 + opened.length)
        opened.push(session)
        return session
      }),
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
    activate: (chat) => Effect.sync(() => void activated.push(chat)),
    seed: (chat, operationId, seed) => Effect.sync(() => void seeded.push(`${chat}:${operationId}:${seed.brief}`)),
    retitle: (chat, name) => void retitled.push(`${chat}:${name}`),
    touched: (chats) => Effect.sync(() => void touched.push(...chats)),
  })
  return {
    db,
    topics,
    /** The store's own create, run on its own. */
    create: (...args: Parameters<typeof topics.create>) => Effect.runPromise(topics.create(...args)),
    touched,
    opened,
    retitled,
    activated,
    seeded,
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      gate = promise
      return resolve
    },
  }
}

/**
 * The Topics service over `store` with one lock and one change bus: `run` runs a program with it, and `changed` holds
 * the Topic ids each write told the bus.
 */
const serviceOf = (store: TopicRegistry) => {
  const changes = makeChanges()
  const changed: number[] = []
  Effect.runSync(changes.on('topics.changed', ({ ids }) => Effect.sync(() => void changed.push(...ids))))
  const layer = Layer.merge(KeyedLock.layer, Layer.succeed(Changes, changes))
  const run = <A, E>(use: (topics: Topics['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Topics.make(store), use).pipe(Effect.provide(layer)))
  return { run, changed }
}

describe('Topics (ADR 0032)', () => {
  it('seeds Personal with Main as its Conversation', () => {
    const { topics } = fixture()
    expect(topics.list()).toEqual([
      expect.objectContaining({ id: 1, name: 'Personal', conversation: '1', personal: true, searchExcluded: false }),
    ])
    expect(topics.archived(1)).toBe(false)
  })

  it('gives Personal and a new Topic everything, unless the new Topic is made with a setup (ADR 0040)', async () => {
    const { topics, create } = fixture()
    expect(topics.get(1).setup).toEqual(EVERYTHING)
    const open = await create({ name: 'Open', operationId: 'op-open' }, 'owner', 10)
    expect(open.topic.setup).toEqual(EVERYTHING)
    const setup = { ...EVERYTHING, mcpServers: [{ serverId: 'notes', tools: ['read'] }], subagents: false }
    const chosen = await create({ name: 'Chosen', operationId: 'op-chosen', setup }, 'agent', 11)
    expect(chosen.topic.setup).toEqual(setup)
    expect(topics.get(chosen.topic.id).setup).toEqual(setup)
  })

  it('reads a setup it cannot decode as nothing chosen, never as everything', () => {
    const { topics, db } = fixture()
    db.update(appTopics).set({ setup: '{"mcpServers":"some"}' }).where(eq(appTopics.id, 1)).run()
    expect(topics.get(1).setup).toEqual({ mcpServers: [], skills: [], apps: [], subagents: false })
  })

  it('creates one Topic and one Pi session per operation id, on retry and concurrently', async () => {
    const { topics: store, opened, db, hold, activated } = fixture()
    const { run, changed } = serviceOf(store)
    const release = hold()
    const both = run((topics) =>
      Effect.all(
        [
          topics.create({ name: '  Work   stuff ', operationId: 'op-1' }, 'owner'),
          topics.create({ name: 'Work stuff', operationId: 'op-1' }, 'owner'),
        ],
        { concurrency: 'unbounded' },
      ),
    )
    release()
    const [made, again] = await both
    expect(made.created).toBe(true)
    expect(again).toEqual({ topic: made.topic, created: false })
    expect(made.topic).toMatchObject({ name: 'Work stuff', conversation: '100', createdBy: 'owner', revision: 1 })
    expect(made.topic.personal).toBeUndefined()
    expect(
      (await run((topics) => topics.create({ name: 'Renamed later', operationId: 'op-1' }, 'agent'))).created,
    ).toBe(false)
    expect(opened).toEqual(['100'])
    // Its memory is turned on with it, and again by a retry, which finishes what a failed first attempt began.
    expect(activated).toEqual(['100', '100', '100'])
    expect(db.select().from(appConversations).where(eq(appConversations.chatId, '100')).get()).toMatchObject({
      role: 'conversation',
      kind: 'main',
      title: 'Work stuff',
      topicId: made.topic.id,
    })
    // Each create tells the bus the Topic it made or found, so a retry announces what a failed first attempt made.
    expect(changed).toEqual([made.topic.id, made.topic.id, made.topic.id])
  })

  it('refuses an active name in any case before making a Pi session, and frees an archived one', async () => {
    const { topics, create, opened } = fixture()
    const { topic } = await create({ name: 'Garden', operationId: 'a' }, 'owner', 10)
    for (const name of ['garden', 'GARDEN ', 'personal'])
      await expect(create({ name, operationId: `b-${name}` }, 'owner', 11)).rejects.toMatchObject({
        _tag: 'Conflict',
      })
    expect(opened).toHaveLength(1)
    await expect(create({ name: '   ', operationId: 'blank' }, 'owner', 11)).rejects.toMatchObject({
      _tag: 'InvalidInput',
    })
    topics.update(topic.id, { archived: true }, 12)
    const again = await create({ name: 'garden', operationId: 'c' }, 'agent', 13)
    expect(again.topic).toMatchObject({ name: 'garden', createdBy: 'agent' })
    expect(() => topics.update(topic.id, { archived: false }, 14)).toThrow(
      expect.objectContaining({ _tag: 'Conflict' }),
    )
    expect(topics.get(topic.id).archivedAt).toBe(12)
  })

  it('renames, archives, restores and opts out of search with one revision per change', async () => {
    const { topics, create, retitled } = fixture()
    const { topic } = await create({ name: 'Trips', operationId: 'op' }, 'owner', 10)
    const renamed = topics.update(topic.id, { name: 'Travel' }, 11)
    expect(renamed).toMatchObject({ name: 'Travel', revision: 2 })
    expect(retitled).toEqual([`${topic.conversation}:Travel`])
    expect(topics.update(topic.id, { name: 'Travel', searchExcluded: false }, 12)).toEqual(renamed)
    const archived = topics.update(topic.id, { archived: true, searchExcluded: true }, 13)
    expect(archived).toMatchObject({ archivedAt: 13, searchExcluded: true, revision: 3 })
    expect(topics.archived(topic.id)).toBe(true)
    expect(topics.update(topic.id, { archived: true }, 14).archivedAt).toBe(13)
    const restored = topics.update(topic.id, { archived: false }, 15)
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.revision).toBe(4)
    expect(topics.update(topic.id, { name: 'travel' }, 16)).toMatchObject({ name: 'travel', revision: 5 })
  })

  it('answers a change before and after, and tells the bus only of a real one', async () => {
    const { topics: store, touched } = fixture()
    const { run, changed } = serviceOf(store)
    const { topic } = await run((topics) => topics.create({ name: 'Trips', operationId: 'op' }, 'owner'))
    expect(touched).toEqual([topic.conversation])
    changed.length = 0
    const renamed = await run((topics) => topics.update(topic.id, { name: 'Travel' }))
    expect(renamed).toMatchObject({ before: { name: 'Trips', revision: 1 }, after: { name: 'Travel', revision: 2 } })
    const same = await run((topics) => topics.update(topic.id, { name: 'Travel' }))
    expect(same.after).toEqual(same.before)
    const refused = await run((topics) => Effect.flip(topics.update(1, { archived: true })))
    expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'personal_topic' })
    expect(changed).toEqual([topic.id])
    // The rename retitled its Conversation, and the conversations' listeners were told once.
    expect(touched).toEqual([topic.conversation, topic.conversation])
  })

  it('never archives Personal, but renames it and changes its search opt-out', () => {
    const { topics } = fixture()
    expect(() => topics.update(1, { archived: true }, 10)).toThrow(
      expect.objectContaining({ _tag: 'InvalidInput', reason: 'personal_topic' }),
    )
    expect(topics.update(1, { name: 'Home', searchExcluded: true }, 11)).toMatchObject({
      name: 'Home',
      personal: true,
      searchExcluded: true,
      revision: 2,
    })
    expect(() => topics.get(9)).toThrow(expect.objectContaining({ _tag: 'NotFound' }))
    expect(() => topics.update(9, { name: 'x' }, 12)).toThrow(expect.objectContaining({ _tag: 'NotFound' }))
  })

  it('writes the seed a Topic made from a discussion starts with, again on a retry, never without one', async () => {
    const { create, seeded } = fixture()
    const seed = { brief: 'Plan the garden beds', sources: [] }
    const { topic } = await create({ name: 'Garden', operationId: 'seeded' }, 'agent', 10, seed)
    await create({ name: 'Garden', operationId: 'seeded' }, 'agent', 11, seed)
    await create({ name: 'Plain', operationId: 'plain' }, 'owner', 12)
    expect(seeded).toEqual([
      `${topic.conversation}:seeded:Plan the garden beds`,
      `${topic.conversation}:seeded:Plan the garden beds`,
    ])
  })
})
