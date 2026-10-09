import { afterEach, describe, expect, it } from 'vitest'
import {
  RECEIPT_RETENTION,
  admitReceipt,
  advanceReceipt,
  receiptIn,
  receiptOf,
  relatedReceipts,
} from '../src/chats/receipts.ts'
import { chatDatabase } from './chats-sqlite.ts'

const BEFORE_RECEIPTS = '20261026000500_routine_topics'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const database = (range: Parameters<typeof chatDatabase>[0] = {}) => {
  const opened = chatDatabase(range)
  cleanups.push(opened.close)
  return opened
}

const send = { kind: 'send', origin: 'owner' } as const

describe('chat operation receipts (unit)', () => {
  it('reads a row admitted before receipts had kinds as a legacy admission, its session kept', () => {
    const { db, sqlite, migrate } = database({ through: BEFORE_RECEIPTS })
    sqlite.exec(
      "INSERT INTO app_chat_operations (chat_id, operation_id, session_id, admitted_at) VALUES ('1', 'old', '41', 10)",
    )
    migrate({ after: BEFORE_RECEIPTS })
    const legacy = { chat: '1', operationId: 'old', session: '41', admittedAt: 10, kind: 'legacy', state: 'admitted' }
    expect(receiptOf(db, 'old')).toEqual(legacy)
    expect(admitReceipt(db, { chat: '1', operationId: 'old', receipt: send, session: () => '43', now: 11 })).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptIn(db, '1', 'old')).toEqual(legacy)
  })

  it('records what an operation is before Pi sees it, and a replay finds its first receipt and session', () => {
    const { db } = database()
    const start = { kind: 'start', origin: 'owner', targetChat: '7' } as const
    expect(admitReceipt(db, { chat: '1', operationId: 'op', receipt: start, session: () => '41', now: 10 })).toEqual({
      session: '41',
      existing: false,
    })
    expect(admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '43', now: 12 })).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptIn(db, '1', 'op')).toEqual({
      chat: '1',
      operationId: 'op',
      session: '41',
      admittedAt: 10,
      kind: 'start',
      origin: 'owner',
      targetChat: '7',
      state: 'admitted',
    })
    expect(receiptIn(db, '2', 'op')).toBeUndefined()
  })

  it('moves a receipt on, stamping when it ended, and finds what an operation led to', () => {
    const { db } = database()
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '41', now: 10 })
    const first = { kind: 'send', origin: 'owner', parentOp: 'op' } as const
    admitReceipt(db, { chat: '7', operationId: 'op:first', receipt: first, session: () => '47', now: 11 })
    advanceReceipt(db, '1', 'op', { state: 'submitted', now: 12 })
    expect(receiptIn(db, '1', 'op')).toMatchObject({ state: 'submitted' })
    expect(receiptIn(db, '1', 'op')).not.toHaveProperty('settledAt')
    advanceReceipt(db, '7', 'op:first', { state: 'refused', reason: 'conversation_closed', now: 13 })
    expect(receiptIn(db, '7', 'op:first')).toMatchObject({
      state: 'refused',
      reason: 'conversation_closed',
      settledAt: 13,
    })
    expect(relatedReceipts(db, 'op').map((receipt) => receipt.operationId)).toEqual(['op:first'])
  })

  it('finds an operation admitted in two chats by its first receipt', () => {
    const { db } = database()
    admitReceipt(db, { chat: '2', operationId: 'op', receipt: send, session: () => '42', now: 20 })
    admitReceipt(db, { chat: '1', operationId: 'op', receipt: send, session: () => '41', now: 10 })
    expect(receiptOf(db, 'op')).toMatchObject({ chat: '1', session: '41' })
    expect(receiptOf(db, 'missing')).toBeUndefined()
  })

  it('drops receipts past the retention, but never the one being replayed', () => {
    const { db } = database()
    admitReceipt(db, { chat: '1', operationId: 'old', receipt: send, session: () => '41', now: 1 })
    admitReceipt(db, { chat: '1', operationId: 'retry', receipt: send, session: () => '41', now: 1 })
    const now = 2 + RECEIPT_RETENTION
    expect(admitReceipt(db, { chat: '1', operationId: 'retry', receipt: send, session: () => '43', now })).toEqual({
      session: '41',
      existing: true,
    })
    expect(receiptOf(db, 'old')).toBeUndefined()
  })
})
