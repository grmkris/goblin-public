import type { OrganizeReceipt, TopicView } from '@goblin/contracts'
import { Conflict, OrganizeGroup, OwnerApi, OwnerGate, TopicsGroup, ownerApiOf } from '@goblin/contracts/api'
import { MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { undoRefusal } from '../src/components/shell/organize.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import { undoMutation } from '../src/organize/queries.ts'
import { createTopicMutation, topicKeys, updateTopicMutation } from '../src/topics/queries.ts'

const PERSONAL: TopicView = {
  id: 1,
  name: 'Personal',
  conversation: '1',
  personal: true,
  searchExcluded: false,
  revision: 1,
  createdBy: 'system',
  createdAt: 1,
}
const RECEIPT = 'org_0123456789abcdef0123456789abcdef'

/** The real Topics and Organize groups served in memory, over a list of Topics and one undoable receipt. */
const fakeOwner = () => {
  const state = { topics: [PERSONAL], undone: false }
  const Topics = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
    handlers
      .handle('create', ({ payload }) => {
        if (state.topics.some((topic) => topic.name === payload.name))
          return Effect.fail(new Conflict({ reason: 'topic_name_taken' }))
        const topic: TopicView = { ...PERSONAL, id: state.topics.length + 1, name: payload.name, personal: undefined }
        state.topics.push(topic)
        return Effect.succeed(topic)
      })
      .handle('update', ({ params, payload }) => {
        const topic = state.topics.find((each) => each.id === params.id) ?? PERSONAL
        return Effect.succeed({ ...topic, ...(payload.name !== undefined && { name: payload.name }) })
      }),
  )
  const Organize = HttpApiBuilder.group(OwnerApi, 'organize', (handlers) =>
    handlers.handle('undo', ({ params }) => {
      if (state.undone) return Effect.fail(new Conflict({ reason: 'undone' }))
      state.undone = true
      const receipt: OrganizeReceipt = {
        id: params.id,
        kind: 'topic.create',
        target: '2',
        actor: 'agent',
        summary: 'Created #Garden',
        at: 1,
        undoable: false,
        undoneAt: 2,
      }
      return Effect.succeed(receipt)
    }),
  )
  const gate = Layer.succeed(
    OwnerGate,
    OwnerGate.of((handler) => handler),
  )
  const server = fakeHttpApi(
    ownerApiOf(TopicsGroup, OrganizeGroup),
    Layer.mergeAll(Topics, Organize).pipe(Layer.provide(gate)),
  )
  return {
    ...server,
    reset: () => {
      state.topics = [PERSONAL]
      state.undone = false
    },
  }
}

const fake = fakeOwner()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => fake.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('organizing through the owner API', () => {
  it('creates a Topic as its operation, and refuses a name in use as a typed conflict', async () => {
    const client = testQueryClient()
    const create = new MutationObserver(client, createTopicMutation(client))
    await expect(create.mutate({ name: 'Garden', operationId: 'op-1' })).resolves.toMatchObject({ name: 'Garden' })
    await expect(create.mutate({ name: 'Garden', operationId: 'op-2' })).rejects.toBeInstanceOf(Conflict)
    expect(fake.calls.at(-1)?.headers.get('x-goblin-operation')).toBe('op-2')
  })

  it('renames a Topic, then marks every Topic read stale', async () => {
    const client = testQueryClient()
    client.setQueryData([...topicKeys.all, 'list'], [PERSONAL])
    const update = new MutationObserver(client, updateTopicMutation(client))
    await expect(update.mutate({ id: 1, change: { name: 'Home' } })).resolves.toMatchObject({ name: 'Home' })
    expect(client.getQueryState([...topicKeys.all, 'list'])?.isInvalidated).toBe(true)
  })

  it('undoes a receipt once, and says why a second Undo is refused', async () => {
    const client = testQueryClient()
    const undo = new MutationObserver(client, undoMutation(client))
    await expect(undo.mutate(RECEIPT)).resolves.toMatchObject({ id: RECEIPT, undoneAt: 2 })
    const again = await undo.mutate(RECEIPT).then(
      () => 'undone twice',
      (failure: unknown) => undoRefusal(failure),
    )
    expect(again).toBe('Already undone.')
    expect(undoRefusal(new Conflict({ reason: 'touched' }))).toBe('Changed since, so it cannot be undone.')
  })
})
