import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { Decisions } from '../../src/decisions/service.ts'
import { noticesOf } from '../../src/layers/routines.ts'
import { Notices } from '../../src/notices/service.ts'
import { NoticeStore } from '../../src/notices/store.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import { WorkspaceLive } from '../../src/workspace/live.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { stub } from '../http/api/fixture.ts'
import { emptySources, feedEvents } from '../workspace-sources.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

const T = 1_800_000_000_000

/** The workspace feed over real notices, one written and one still unwritten, every other source empty. */
function feed() {
  const database = chatDatabase()
  open.push(database)
  const store = new NoticeStore(durable(database.db))
  for (const id of ['written', 'unwritten']) {
    const notice = {
      id,
      routineId: 'rt_1',
      source: 'event' as const,
      chatId: '5',
      entryRequestId: id,
      label: 'Sidequest',
    }
    store.claim({ ...notice, connectionId: 'sq', title: id, body: null, url: null, at: T, createdAt: T }, false)
  }
  store.written('written', T)
  const sources = Layer.mergeAll(
    Layer.succeed(Notices, noticesOf(store)),
    Layer.succeed(Changes, makeChanges()),
    stub(Decisions, { list: Effect.succeed([]) }),
    emptySources,
  )
  return { store, layer: Layer.provideMerge(WorkspaceLive, sources) }
}

describe('notifications in the workspace feed (ADR 0041)', () => {
  it('carries the written ones in its snapshot, and each one written or read as a change', async () => {
    const { store, layer } = feed()
    const program = feedEvents(
      3,
      Effect.gen(function* () {
        const changes = yield* Changes
        store.written('unwritten', T + 1000)
        yield* changes.publish('notices.changed', { ids: ['unwritten'] })
        yield* (yield* Notices).read(['written', 'gone'], T + 2000)
        yield* changes.publish('notices.changed', { ids: ['written', 'gone'] })
      }),
    )
    const [snapshot, ...changes] = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(snapshot).toMatchObject({
      event: 'snapshot',
      data: { notifications: [{ id: 'written', chat: '5', label: 'Sidequest', at: T / 1000, readAt: null }] },
    })
    expect(changes).toEqual([
      {
        event: 'change',
        data: [{ type: 'notification', notification: expect.objectContaining({ id: 'unwritten', readAt: null }) }],
      },
      {
        event: 'change',
        data: [
          { type: 'notification', notification: expect.objectContaining({ id: 'written', readAt: T / 1000 + 2 }) },
        ],
      },
    ])
  })
})
