import { afterEach, describe, expect, it } from 'vitest'
import { MoveStore, moveReceipt } from '../src/chats/moves.ts'
import { appChatMoves, appConversations, appRegistry } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

/** An MCP App placement's fixed fields. */
const app = { source: 'mcp', serverId: 'fixture', tool: 'board', resourceUri: 'ui://board' } as const

const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  db.insert(appConversations)
    .values([
      { chatId: '1', piSession: '41', kind: 'main', role: 'primary', createdAt: 1 },
      // A thread branched from the moved turn, one from before it, and the helpers before and after it.
      { chatId: '60', piSession: '60', kind: 'thread', parentSession: '1', forkEntry: 52, createdAt: 1 },
      { chatId: '61', piSession: '61', kind: 'thread', parentSession: '1', forkEntry: 30, createdAt: 1 },
      { chatId: '45', piSession: '45', kind: 'subagent', parentSession: '1', spawnerSession: '41', createdAt: 1 },
      { chatId: '53', piSession: '53', kind: 'subagent', parentSession: '1', spawnerSession: '41', createdAt: 1 },
    ])
    .run()
  db.insert(appRegistry)
    .values([
      { ...app, sessionId: '41', chatId: '1', callId: 'c52', entryId: 52, title: 'in the turn', createdAt: 1 },
      { ...app, sessionId: '41', chatId: '1', callId: 'c20', entryId: 20, title: 'before it', createdAt: 1 },
    ])
    .run()
  return { db, store: new MoveStore(db) }
}

describe('the moves store (ADR 0034)', () => {
  it('walks a move from requested to settled, one active move per chat, refusals kept for their operation', () => {
    const { db, store } = fixture()
    const refused = store.refuse({ operation: 'op-0', chat: '1', entry: 50, reason: 'streaming', now: 2 })
    expect(moveReceipt(refused)).toEqual({
      operationId: 'op-0',
      chat: '1',
      state: 'refused',
      reason: 'streaming',
    })
    const begun = store.begin({ operation: 'op-1', chat: '1', source: '41', entry: 50, end: 55, now: 3 })
    expect(store.active('1')?.operationId).toBe('op-1')
    expect(() => store.begin({ operation: 'op-2', chat: '1', source: '41', entry: 50, end: 55, now: 3 })).toThrow()
    expect(store.moved('1', 50)).toBe(false)
    const forked = store.forked(begun.operationId, '70', 4)
    expect(forked).toMatchObject({ state: 'forked', forkSession: '70' })
    expect(store.moved('1', 50)).toBe(true)
    expect(store.unfinished().map((row) => row.operationId)).toEqual(['op-1'])
    store.register(forked, { chat: '70', title: 'Moved', topic: 1, before: 49, recallThrough: 3 }, 5)
    const rows = new Map(
      db
        .select()
        .from(appConversations)
        .all()
        .map((row) => [row.chatId, row]),
    )
    expect(rows.get('70')).toMatchObject({ piSession: '70', parentSession: '1', forkEntry: 49, originOp: 'op-1' })
    expect(rows.get('60')?.parentSession).toBe('70')
    expect(rows.get('61')?.parentSession).toBe('1')
    expect(rows.get('53')?.parentSession).toBe('70')
    expect(rows.get('45')?.parentSession).toBe('1')
    expect(
      db
        .select()
        .from(appRegistry)
        .all()
        .map((row) => [row.title, row.chatId]),
    ).toEqual([
      ['in the turn', '70'],
      ['before it', '1'],
    ])
    expect(store.saveRelays('op-1', [7, 8], 6)).toEqual([7, 8])
    expect(store.relaysOf(store.require('op-1'))).toEqual([7, 8])
    store.respawn('41', '70', ['53'])
    expect(
      db
        .select()
        .from(appConversations)
        .all()
        .find((row) => row.chatId === '53')?.spawnerSession,
    ).toBe('70')
    store.settled('op-1', 7)
    expect(moveReceipt(store.require('op-1'))).toEqual({
      operationId: 'op-1',
      chat: '1',
      thread: '70',
      state: 'settled',
    })
    expect(store.active('1')).toBeUndefined()
    expect(store.unfinished()).toEqual([])
    expect(db.select().from(appChatMoves).all()).toHaveLength(2)
  })
})
