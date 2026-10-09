import { afterEach, describe, expect, it } from 'vitest'
import { ChatDirectory } from '../src/chats/directory.ts'
import { appConversations } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { chatDatabase } from './chats-sqlite.ts'

const noop = (): void => undefined
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '41', kind: 'main', role: 'primary', createdAt: 1 },
      { chatId: '2', piSession: '42', kind: 'thread', parentSession: '1', createdAt: 1 },
    ])
    .run()
  return { chats: new ChatDirectory(db), db }
}

describe('logical chat directory', () => {
  it('resolves both directions and refuses unregistered chats', () => {
    const { chats } = fixture()
    expect(chats.primary()).toBe('1')
    expect(chats.session(chats.primary())).toBe('41')
    expect(chats.chatOf('41')).toBe('1')
    expect(chats.chatOf('1')).toBeUndefined()
    expect(() => chats.session('99')).toThrow(expect.objectContaining({ _tag: 'NotFound' }))
  })

  it('records intent first and keeps retries on the original session after a fenced rebind', () => {
    const { chats, db } = fixture()
    const rebound: string[] = []
    const unsubscribe = chats.onRebind((chat) => rebound.push(chat))
    expect(chats.admit('1', 'owner:1', 10)).toEqual({ session: '41', existing: false })
    chats.rebind('1', { from: '41', epoch: 0 }, '43', 11)
    expect(chats.session('1')).toBe('43')
    expect(chats.chatOf('41')).toBeUndefined()
    expect(chats.chatOf('43')).toBe('1')
    expect(chats.admit('1', 'owner:1', 12)).toEqual({ session: '41', existing: true })
    expect(chats.operation('1', 'owner:1')).toBe('41')
    expect(chats.admit('1', 'owner:2', 12)).toEqual({ session: '43', existing: false })
    expect(chats.operation('2', 'owner:1')).toBeUndefined()
    expect(db.select().from(appConversations).all()[0]).toMatchObject({ chatId: '1', epoch: 1, role: 'primary' })
    expect(rebound).toEqual(['1'])
    unsubscribe()
    chats.rebind('1', { from: '43', epoch: 1 }, '44', 13)
    expect(rebound).toEqual(['1'])
  })

  it('rejects stale epochs, stale sessions and another chat’s session without changing ownership', () => {
    const { chats } = fixture()
    for (const [expected, to] of [
      [{ from: '41', epoch: 1 }, '43'],
      [{ from: '40', epoch: 0 }, '43'],
      [{ from: '41', epoch: 0 }, '42'],
    ] as const) {
      expect(() => chats.rebind('1', expected, to, 10)).toThrow(expect.objectContaining({ _tag: 'Conflict' }))
    }
    expect(chats.session('1')).toBe('41')
    expect(chats.session('2')).toBe('42')
  })

  it('prunes receipts older than thirty days while preserving the current retry and other chat keys', () => {
    const { chats } = fixture()
    chats.admit('1', 'old', 1)
    chats.admit('1', 'retry', 1)
    chats.admit('2', 'retry', 2)
    const now = 30 * 24 * 60 * 60 + 10
    expect(chats.admit('1', 'retry', now)).toEqual({ session: '41', existing: true })
    expect(chats.operation('1', 'old')).toBeUndefined()
    expect(chats.operation('2', 'retry')).toBe('42')
  })

  it('serializes one chat, allows independent chats, and releases after a failed admission', async () => {
    const { chats } = fixture()
    const events: string[] = []
    let release = noop
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = chats.withChat('1', async () => {
      events.push('first')
      await held
      throw new Error('fixture')
    })
    const second = chats.withChat('1', async () => {
      events.push('second')
      return 2
    })
    await chats.withChat('2', async () => {
      events.push('independent')
    })
    expect(events).toEqual(['first', 'independent'])
    release()
    await expect(first).rejects.toThrow('fixture')
    await expect(second).resolves.toBe(2)
    await expect(chats.withChat('1', async () => 3)).resolves.toBe(3)
    expect(events).toEqual(['first', 'independent', 'second'])
  })

  it('resolves passive writes after an earlier rebind and holds admission only through submission', async () => {
    const { chats } = fixture()
    let releaseMove = noop
    const moved = new Promise<void>((resolve) => {
      releaseMove = resolve
    })
    const move = chats.withChat('1', async () => {
      await moved
      chats.rebind('1', { from: '41', epoch: 0 }, '43', 10)
    })
    const submitted: string[] = []
    const write = chats.passiveWrite('1', async (session) => {
      submitted.push(session)
    })
    await chats.passiveWrite('2', async (session) => {
      submitted.push(session)
    })
    expect(submitted).toEqual(['42'])
    releaseMove()
    await move
    await write
    expect(submitted).toEqual(['42', '43'])
    await expect(chats.withChat('1', async () => chats.admit('1', 'next', 11))).resolves.toEqual({
      session: '43',
      existing: false,
    })
  })

  it("tells a Topic's Conversation from its threads and finds the Conversation above any chat", () => {
    const { chats, db } = fixture()
    db.insert(appTopics)
      .values({ id: 7, name: 'Work', chatId: '70', createdBy: 'owner', createdAt: 1, updatedAt: 1 })
      .run()
    db.insert(appConversations)
      .values([
        { chatId: '70', piSession: '70', kind: 'main', role: 'conversation', topicId: 7, createdAt: 2 },
        { chatId: '71', piSession: '71', kind: 'thread', parentSession: '70', topicId: 7, createdAt: 2 },
        { chatId: '72', piSession: '72', kind: 'subagent', parentSession: '71', topicId: 7, createdAt: 2 },
        { chatId: '73', piSession: '73', kind: 'thread', parentSession: '74', topicId: 7, createdAt: 2 },
        { chatId: '74', piSession: '74', kind: 'thread', parentSession: '73', topicId: 7, createdAt: 2 },
      ])
      .run()
    expect(['1', '2', '70', '71', '72'].map((chat) => chats.isConversation(chat))).toEqual([
      true,
      false,
      true,
      false,
      false,
    ])
    expect(chats.topicOf('2')).toBe(1)
    expect(chats.topicOf('72')).toBe(7)
    expect(chats.conversationOf(1)).toBe('1')
    expect(chats.conversationOf(7)).toBe('70')
    expect(['1', '2', '70', '72'].map((chat) => chats.conversationAbove(chat))).toEqual(['1', '1', '70', '70'])
    // Stored parents that loop end at the Topic's Conversation instead of looping.
    expect(chats.conversationAbove('73')).toBe('70')
    expect(() => chats.conversationOf(9)).toThrow(expect.objectContaining({ _tag: 'NotFound' }))
    expect(() => chats.isConversation('99')).toThrow(expect.objectContaining({ _tag: 'NotFound' }))
  })
})
