import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { afterEach, describe, expect, it } from 'vitest'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { appRunEvents } from '../src/storage/schema.ts'
import { chatDatabase } from './chats-sqlite.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = () => {
  const { db, close } = chatDatabase()
  cleanups.push(close)
  return { db, ledger: new RunLedger(db) }
}

const turn: RunEvent = {
  id: 'turn:op-1',
  kind: 'turn.submitted',
  status: 'error',
  conversationId: '41',
  operationId: 'op-1',
  startedAt: 100,
  endedAt: 120,
  attributes: { [RunAttribute.errorType]: 'Internal' },
}

describe('run ledger reads', () => {
  it('skips and counts a row whose kind this build does not know, and reads the rest', () => {
    const { db, ledger } = fixture()
    ledger.ended(turn)
    // A newer build wrote this row: its kind is unknown here, which must not fail any read.
    db.insert(appRunEvents)
      .values({
        id: 'future:op-1',
        kind: 'from-a-newer-build',
        status: 'error',
        conversationId: '41',
        operationId: 'op-1',
        taskId: null,
        startedAt: 110,
        endedAt: 111,
        attributes: '{}',
      })
      .run()

    expect(ledger.forOperation('op-1')).toEqual([turn])
    expect(ledger.forOperations(['op-1'])).toEqual([turn])
    expect(ledger.read('future:op-1')).toBeUndefined()
    expect(ledger.read(turn.id)).toEqual(turn)
    expect(ledger.problems(0, 10)).toEqual([turn])
    expect(ledger.turns(0, 10)).toEqual([turn])
    expect(ledger.skipped).toBe(4)
  })

  it('keeps paging problems past a full page of unknown rows', () => {
    const { db, ledger } = fixture()
    ledger.ended({ ...turn, startedAt: 1 })
    db.insert(appRunEvents)
      .values(
        Array.from({ length: 70 }, (_, index) => ({
          id: `future:${index}`,
          kind: 'from-a-newer-build',
          status: 'error' as const,
          conversationId: null,
          operationId: null,
          taskId: null,
          startedAt: 10 + index,
          endedAt: null,
          attributes: '{}',
        })),
      )
      .run()

    expect(ledger.problems(0, 5)).toEqual([{ ...turn, startedAt: 1 }])
    expect(ledger.skipped).toBe(70)
  })
})
