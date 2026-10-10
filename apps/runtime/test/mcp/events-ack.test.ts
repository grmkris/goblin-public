import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'
import { Conflict } from '../../src/http/errors.ts'
import { makeEvents } from '../../src/mcp/events.ts'
import { SqliteEventStore } from '../../src/mcp/events/store.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { appEventConsumerReceipts, appMetadata } from '../../src/storage/schema.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { fake } from '../fake.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

const RECEIPT = {
  subscriptionId: 'sub-1',
  webhookId: 'evt_1',
  consumerId: 'routine:rt_1',
  revision: 1,
  operationId: 'op',
}

/** Events over SQLite with one pending delivery receipt; acknowledging needs no connection, key or authority. */
const pending = async () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  db.insert(appEventConsumerReceipts)
    .values({ ...RECEIPT, state: 'pending' })
    .run()
  const store = new SqliteEventStore(durable(db))
  // `ackWith` reads only the store and the clock; the rest of the engine is never reached here.
  const events = await Effect.runPromise(
    makeEvents(fake<Parameters<typeof makeEvents>[0]>({ store })).pipe(Effect.provide(SingleFlight.layer)),
  )
  const state = () => db.select().from(appEventConsumerReceipts).get()?.state
  const written = () => db.select().from(appMetadata).all().length
  const write = () => db.insert(appMetadata).values({ id: 'pending-handoff', value: '1' }).run()
  return { events, state, written, write }
}

describe('an Events acknowledgement with a write of its own (unit)', () => {
  it('acknowledges and writes in one transaction', async () => {
    const { events, state, written, write } = await pending()
    await Effect.runPromise(events.ackWith(RECEIPT, write))
    expect(state()).toBe('accepted')
    expect(written()).toBe(1)
  })

  it('keeps neither when the write fails, so the delivery is handed over again', async () => {
    const { events, state, written, write } = await pending()
    const failed = await Effect.runPromise(
      Effect.flip(
        events.ackWith(RECEIPT, () => {
          write()
          throw new Conflict({ reason: 'pending handoff refused' })
        }),
      ),
    )
    expect(failed).toBeInstanceOf(Conflict)
    expect(state()).toBe('pending')
    expect(written()).toBe(0)
  })
})
