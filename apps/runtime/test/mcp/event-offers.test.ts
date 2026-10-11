import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionEventOffers } from '../../src/mcp/events/offers.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

const offers = () => {
  const database = chatDatabase()
  open.push(database)
  return new ConnectionEventOffers(durable(database.db))
}

describe("a connection's offer of events (ADR 0041)", () => {
  it('stays open until dismissed or answered by a routine, and a dismissal never undoes a routine', () => {
    const store = offers()
    expect(store.settled('sq-worker')).toBeUndefined()
    store.settle('sq-worker', 'dismissed', 1)
    expect(store.settled('sq-worker')).toBe('dismissed')
    store.settle('sq-worker', 'done', 2)
    store.settle('sq-worker', 'dismissed', 3)
    expect(store.settled('sq-worker')).toBe('done')
    store.remove('sq-worker')
    expect(store.settled('sq-worker')).toBeUndefined()
  })
})
