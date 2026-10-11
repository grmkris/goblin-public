import { afterEach, describe, expect, it } from 'vitest'
import { actingChatSession, openChatSession, personaForkOf } from '../src/chats/directory.ts'
import { appPersonaChats } from '../src/storage/personas.ts'
import { appConversations } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** A thread `50` of Personal, and the hidden fork `51` a Persona answers in there at revision 2. */
const directory = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  db.insert(appConversations)
    .values([
      { chatId: '50', piSession: '50', kind: 'thread', createdAt: 1 },
      { chatId: '51', piSession: '51', kind: 'thread', role: 'persona', parentSession: '50', createdAt: 1 },
    ])
    .run()
  db.insert(appPersonaChats).values({ chatId: '51', personaId: 3, revision: 2, setup: '{}', createdAt: 1 }).run()
  return db
}

describe('a Persona fork in the chat directory (ADR 0041)', () => {
  it('acts while the chat it answers in is open, though it never takes new work itself', () => {
    const db = directory()
    expect(actingChatSession(db, '51')).toBe('51')
    expect(actingChatSession(db, '50')).toBe('50')
    expect(() => openChatSession(db, '51')).toThrow(expect.objectContaining({ reason: 'persona_turn' }))
    db.update(appConversations).set({ closedAt: 5 }).run()
    expect(() => actingChatSession(db, '51')).toThrow(expect.objectContaining({ reason: 'conversation_closed' }))
  })

  it('is read with the chat it answers in and its Persona; any other chat is none', () => {
    const db = directory()
    expect(personaForkOf(db, '51')).toEqual({ parent: '50', persona: 3, revision: 2 })
    expect([personaForkOf(db, '50'), personaForkOf(db, '99')]).toEqual([undefined, undefined])
  })
})
