import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatDirectory, registerChat } from '../src/chats/directory.ts'
import { admitReceipt } from '../src/chats/receipts.ts'
import { appConversations } from '../src/storage/schema.ts'
import { appTopics } from '../src/storage/topics.ts'
import { chatDatabase } from './chats-sqlite.ts'

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

  it('registers every chat row through one inserter: its own session unless given, kept or refused when there', () => {
    const { chats, db } = fixture()
    expect(registerChat(db, { chatId: '7', kind: 'thread', parentSession: '1', createdAt: 3 })).toBe(true)
    expect(chats.session('7')).toBe('7')
    expect(registerChat(db, { chatId: '7', kind: 'thread', title: 'again', createdAt: 4 }, 'keep')).toBe(false)
    expect(db.select().from(appConversations).where(eq(appConversations.chatId, '7')).get()).toMatchObject({
      title: null,
      createdAt: 3,
    })
    expect(() => registerChat(db, { chatId: '7', kind: 'thread', createdAt: 5 })).toThrow()
  })

  it('finds the session an operation was admitted to from its receipt', () => {
    const { chats, db } = fixture()
    const receipt = { kind: 'send', origin: 'owner' } as const
    admitReceipt(db, { chat: '1', operationId: 'owner:1', receipt, session: () => chats.session('1'), now: 10 })
    db.update(appConversations).set({ piSession: '43' }).where(eq(appConversations.chatId, '1')).run()
    expect(chats.operation('1', 'owner:1')).toBe('41')
    expect(chats.operation('2', 'owner:1')).toBeUndefined()
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
