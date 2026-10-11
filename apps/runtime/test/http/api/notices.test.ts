import { NoticesGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { noticesOf } from '../../../src/layers/routines.ts'
import { Resident } from '../../../src/mcp/service.ts'
import { NoticesHandlers } from '../../../src/notices/api.ts'
import { Notices } from '../../../src/notices/service.ts'
import { NoticeStore } from '../../../src/notices/store.ts'
import { Changes, makeChanges } from '../../../src/runtime/changes.ts'
import { chatDatabase, durable } from '../../chats-sqlite.ts'
import { callOwner } from '../../owner-client.ts'
import { currentResident, plans, post, serve, served } from './fixture.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

/** The notices group as the agent serves it, over real notices with two written into chat `5`. */
function fixture() {
  const database = chatDatabase()
  open.push(database)
  const store = new NoticeStore(durable(database.db))
  for (const id of ['n1', 'n2']) {
    const notice = { id, routineId: 'rt_1', source: 'event' as const, chatId: '5', entryRequestId: id }
    store.claim(
      { ...notice, connectionId: 'sq', label: 'Sidequest', title: id, body: null, url: null, at: 1, createdAt: 1 },
      false,
    )
    store.written(id, 2)
  }
  const published: (readonly string[])[] = []
  const changes = makeChanges()
  Effect.runSync(changes.on('notices.changed', ({ ids }) => Effect.sync(() => void published.push(ids))))
  const { fetch } = serve(
    served([NoticesGroup], NoticesHandlers).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Notices, noticesOf(store)),
          Layer.succeed(Changes, changes),
          Layer.succeed(Resident, currentResident().service),
          plans(),
        ),
      ),
    ),
  )
  return { fetch, store, published }
}

describe('the notices group', () => {
  it('reads the notifications the owner marked, tells the feed, and leaves the others unread', async () => {
    const { fetch, store, published } = fixture()
    const read = await fetch(post('/api/notices/read', { ids: ['n1', 'gone'] }))
    expect(read.status).toBe(200)
    expect(store.get('n1')?.readAt).toEqual(expect.any(Number))
    expect(store.get('n2')?.readAt).toBeNull()
    expect(published).toEqual([['n1', 'gone']])
  })

  it('refuses more than two hundred at once', async () => {
    const { fetch, published } = fixture()
    const ids = Array.from({ length: 201 }, (_, index) => `n${String(index)}`)
    expect((await fetch(post('/api/notices/read', { ids }))).status).toBe(400)
    expect(published).toEqual([])
  })

  it("serves the web's typed client", async () => {
    const { fetch, store } = fixture()
    await callOwner({ fetch }, (api) => api.notices.read({ payload: { ids: ['n2'] } }))
    expect(store.get('n2')?.readAt).toEqual(expect.any(Number))
  })
})
