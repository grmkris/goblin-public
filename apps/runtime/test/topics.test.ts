import type { TopicView } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { appConversations } from '../src/storage/schema.ts'
import { TopicRegistry } from '../src/topics/registry.ts'
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
  let gate: Promise<void> = Promise.resolve()
  const topics = new TopicRegistry(db, {
    open: async () => {
      await gate
      const session = String(100 + opened.length)
      opened.push(session)
      return session
    },
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
    retitle: (chat, name) => void retitled.push(`${chat}:${name}`),
  })
  const changes: TopicView[] = []
  topics.onChange((changed) => changes.push(...changed))
  return {
    db,
    topics,
    opened,
    retitled,
    changes,
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<void>()
      gate = promise
      return resolve
    },
  }
}

describe('Topics (ADR 0032)', () => {
  it('seeds Personal with Main as its Conversation', () => {
    const { topics } = fixture()
    expect(topics.list()).toEqual([
      expect.objectContaining({ id: 1, name: 'Personal', conversation: '1', personal: true, searchExcluded: false }),
    ])
    expect(topics.archived(1)).toBe(false)
  })

  it('creates one Topic and one Pi session per operation id, on retry and concurrently', async () => {
    const { topics, opened, db, changes, hold } = fixture()
    const release = hold()
    const first = topics.create({ name: '  Work   stuff ', operationId: 'op-1' }, 'owner', 10)
    const repeat = topics.create({ name: 'Work stuff', operationId: 'op-1' }, 'owner', 11)
    release()
    const [made, again] = await Promise.all([first, repeat])
    expect(made.created).toBe(true)
    expect(again).toEqual({ topic: made.topic, created: false })
    expect(made.topic).toMatchObject({ name: 'Work stuff', conversation: '100', createdBy: 'owner', revision: 1 })
    expect(made.topic.personal).toBeUndefined()
    expect((await topics.create({ name: 'Renamed later', operationId: 'op-1' }, 'agent', 12)).created).toBe(false)
    expect(opened).toEqual(['100'])
    expect(db.select().from(appConversations).where(eq(appConversations.chatId, '100')).get()).toMatchObject({
      role: 'conversation',
      kind: 'main',
      title: 'Work stuff',
      topicId: made.topic.id,
    })
    expect(changes.map((topic) => topic.id)).toEqual([made.topic.id])
  })

  it('refuses an active name in any case before making a Pi session, and frees an archived one', async () => {
    const { topics, opened } = fixture()
    const { topic } = await topics.create({ name: 'Garden', operationId: 'a' }, 'owner', 10)
    for (const name of ['garden', 'GARDEN ', 'personal'])
      await expect(topics.create({ name, operationId: `b-${name}` }, 'owner', 11)).rejects.toMatchObject({
        _tag: 'Conflict',
      })
    expect(opened).toHaveLength(1)
    await expect(topics.create({ name: '   ', operationId: 'blank' }, 'owner', 11)).rejects.toMatchObject({
      _tag: 'InvalidInput',
    })
    topics.update(topic.id, { archived: true }, 12)
    const again = await topics.create({ name: 'garden', operationId: 'c' }, 'agent', 13)
    expect(again.topic).toMatchObject({ name: 'garden', createdBy: 'agent' })
    expect(() => topics.update(topic.id, { archived: false }, 14)).toThrow(
      expect.objectContaining({ _tag: 'Conflict' }),
    )
    expect(topics.get(topic.id).archivedAt).toBe(12)
  })

  it('renames, archives, restores and opts out of search with one revision per change', async () => {
    const { topics, retitled, changes } = fixture()
    const { topic } = await topics.create({ name: 'Trips', operationId: 'op' }, 'owner', 10)
    changes.length = 0
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
    expect(changes.map((change) => change.revision)).toEqual([2, 3, 4, 5])
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
})
