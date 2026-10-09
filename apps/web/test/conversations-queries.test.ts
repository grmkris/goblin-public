import { ConversationsGroup, OwnerApi, OwnerGate, ownerApiOf } from '@goblin/contracts/api'
import { InfiniteQueryObserver, MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { historyQuery, streamReads, submitMutation } from '../src/conversations/queries.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'

/** Entries 1 to 9 of chat 7, two to a page: a page before `before` holds the two entries just older. */
const page = (before: number) => {
  const ids = [before - 2, before - 1].filter((id) => id >= 1)
  return { entries: ids.map((id) => ({ id, type: 'message' })), more: (ids[0] ?? 1) > 1 }
}

const unused = () => Effect.die('not used')

/** The real conversations group served in memory: its history pages and the owner's messages, nothing else. */
const fakeOwner = () => {
  const Conversations = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
    handlers
      .handle('list', unused)
      .handle('create', unused)
      .handle('update', unused)
      .handle('submit', ({ payload }) =>
        Effect.succeed({ operationId: payload.operationId, session: 'session-7', accepted: true }),
      )
      .handle('startThread', unused)
      .handle('move', unused)
      .handle('stop', unused)
      .handle('queue', () => Effect.succeed({ inputs: [{ id: 4, mode: 'followUp' as const, content: 'later' }] }))
      .handle('removeQueued', unused)
      .handle('markRead', unused)
      .handle('capabilities', unused)
      .handle('setCapability', unused)
      .handle('composer', unused)
      .handle('snapshot', () => Effect.succeed({ type: 'snapshot', entries: [], tools: [], inbox: [] }))
      .handle('history', ({ query }) => Effect.succeed(page(query.before)))
      .handle('sources', unused),
  )
  const gate = Layer.succeed(
    OwnerGate,
    OwnerGate.of((handler) => handler),
  )
  return fakeHttpApi(ownerApiOf(ConversationsGroup), Conversations.pipe(Layer.provide(gate)))
}

const fake = fakeOwner()
let seen = 0
const calls = () => fake.calls.slice(seen)
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => {
  seen = fake.calls.length
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('conversation queries', () => {
  it('page a chat history backwards from where its snapshot starts, until nothing older remains', async () => {
    const client = testQueryClient()
    const history = new InfiniteQueryObserver(client, historyQuery('7', 6))
    const unsubscribe = history.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(history.getCurrentResult().data?.pages).toHaveLength(1))
      expect(history.getCurrentResult().hasNextPage).toBe(true)
      await history.fetchNextPage()
      await history.fetchNextPage()
      const pages = history.getCurrentResult().data?.pages ?? []
      expect(pages.map((each) => each.entries.length)).toEqual([2, 2, 1])
      expect(history.getCurrentResult().hasNextPage).toBe(false)
      expect(calls().map((request) => new URL(request.url).search)).toEqual(['?before=6', '?before=4', '?before=2'])
    } finally {
      unsubscribe()
    }
  })

  it('read no history while the snapshot starts at the beginning', async () => {
    const client = testQueryClient()
    const history = new InfiniteQueryObserver(client, historyQuery('7', undefined))
    const unsubscribe = history.subscribe(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    expect(history.getCurrentResult().fetchStatus).toBe('idle')
    expect(calls()).toEqual([])
  })

  it("send the owner's message as its operation, and read the stream's own snapshot and queue", async () => {
    const client = testQueryClient()
    const submit = new MutationObserver(client, submitMutation)
    await expect(submit.mutate({ id: '7', message: { input: 'Hello', operationId: 'op-7' } })).resolves.toEqual({
      operationId: 'op-7',
      session: 'session-7',
      accepted: true,
    })
    expect(calls().at(-1)?.headers.get('x-goblin-operation')).toBe('op-7')
    const reads = streamReads('7')
    const signal = new AbortController().signal
    await expect(reads.snapshot(signal)).resolves.toMatchObject({ type: 'snapshot' })
    await expect(reads.queue(signal)).resolves.toEqual({ inputs: [{ id: 4, mode: 'followUp', content: 'later' }] })
  })
})
