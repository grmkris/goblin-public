import { afterEach, describe, expect, it } from 'vitest'
import { EVENT_LIMITS, SqliteEventStore, type Subscription } from '../../src/mcp/events/store.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

/** An events store over real SQLite with the application migrations applied. */
const store = () => {
  const database = chatDatabase()
  open.push(database)
  return new SqliteEventStore(durable(database.db))
}

const NOW = 1_800_000_000_000

/** One subscription row named `id`, live unless `status` says otherwise. */
const row = (
  id: string,
  status: Subscription['status'] = 'active',
  patch: Partial<Subscription> = {},
): Subscription => ({
  id,
  connectionId: 'sidequest',
  name: `event.${id}`,
  argumentsJson: '{}',
  endpoint: 'https://events.test/mcp',
  principal: 'owner',
  callbackUrl: 'https://goblin.test/hooks/mcp-events/owner/token',
  remoteId: `remote-${id}`,
  secret: 'sealed',
  previousSecret: null,
  graceUntil: null,
  cursor: null,
  refreshBefore: NOW + 3_600_000,
  nextRefreshAt: NOW,
  nextPollAt: NOW,
  status,
  lastError: null,
  lastReceiptAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
})

describe('the Events store keeps every live subscription in view', () => {
  it('lists and counts live rows however many there are, never tombstones', () => {
    const events = store()
    for (let index = 0; index < 40; index++) events.save(row(`gone-${index}`, 'tombstone'))
    for (let index = 0; index < EVENT_LIMITS.subscriptions - 4; index++) events.save(row(`live-${index}`))
    expect(events.count()).toBe(EVENT_LIMITS.subscriptions - 4)
    expect(events.live()).toHaveLength(EVENT_LIMITS.subscriptions - 4)
    expect(events.live().every((each) => each.status !== 'tombstone')).toBe(true)
  })

  it('finds a producer id among tombstones too, and pending intents only while recent', () => {
    const events = store()
    events.save(row('gone', 'tombstone', { remoteId: 'remote-x' }))
    events.save(row('fresh', 'pending', { remoteId: null, updatedAt: NOW }))
    events.save(row('stale', 'pending', { remoteId: null, updatedAt: NOW - 600_000 }))
    expect(events.byRemote('remote-x').map((each) => each.id)).toEqual(['gone'])
    expect(events.pendingSince(NOW - 300_000).map((each) => each.id)).toEqual(['fresh'])
  })

  it('prunes a tombstone nothing refers to, and keeps one with an unfinished delivery or a live lease', () => {
    const events = store()
    events.save(row('done', 'tombstone'))
    events.save(row('waiting', 'tombstone'))
    events.save(row('leased', 'tombstone', { lastError: 'cleanup failed', refreshBefore: NOW + 60_000 }))
    events.save(row('lapsed', 'tombstone', { lastError: 'cleanup failed', refreshBefore: NOW - 1 }))
    events.receive({
      subscriptionId: 'waiting',
      webhookId: 'evt-1',
      kind: 'occurrence',
      envelope: 'sealed',
      bytes: 10,
      receivedAt: NOW,
      nextAttemptAt: NOW,
    })
    events.prune(NOW)
    expect(['done', 'waiting', 'leased', 'lapsed'].filter((id) => events.get(id) !== undefined)).toEqual([
      'waiting',
      'leased',
    ])
  })

  it('knows when a sweep next has work, and that nothing waits when no subscription runs', () => {
    const events = store()
    expect(events.nextDue()).toBeUndefined()
    events.save(row('gone', 'tombstone', { nextPollAt: NOW - 5000 }))
    events.save(row('ended', 'terminated', { nextPollAt: NOW - 4000 }))
    expect(events.nextDue()).toBeUndefined()
    events.save(row('live', 'active', { nextRefreshAt: NOW + 50_000, nextPollAt: NOW + 30_000 }))
    expect(events.nextDue()).toBe(NOW + 30_000)
    events.receive({
      subscriptionId: 'live',
      webhookId: 'evt-1',
      kind: 'occurrence',
      envelope: 'sealed',
      bytes: 10,
      receivedAt: NOW,
      nextAttemptAt: NOW + 2000,
    })
    expect(events.nextDue()).toBe(NOW + 2000)
  })
})
