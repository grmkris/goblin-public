import {
  type ApiCode,
  Conflict,
  ERROR_COPY,
  MemoryGroup,
  OwnerApi,
  OwnerAdmission,
  TopicsGroup,
  ownerApiOf,
} from '@goblin/contracts/api'
import { type CreateTopic, EVERYTHING, type MemoryStatus, type TopicView } from '@goblin/contracts'
import { MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../../src/lib/api.ts'
import { ApiDefect, makeApiQuery, withOperation } from '../../src/lib/query/api-query.ts'
import { ERROR_KINDS, type ErrorKind, describeError, messageOf } from '../../src/lib/query/app-error.ts'
import { fakeHttpApi, testQueryClient } from '../../src/lib/query/testing.ts'
import { unusedHandlers } from './unused-handlers.ts'

const RAY = '7f3a9c12e4b5a6d7-AMS'
const PERSONAL: TopicView = {
  id: 1,
  name: 'Personal',
  conversation: '1',
  personal: true,
  searchExcluded: false,
  revision: 1,
  setup: EVERYTHING,
  createdBy: 'system',
  createdAt: 1,
}

const MEMORY: MemoryStatus = { messages: 3, summarized: 1 }

/**
 * The real owner contract's Topics and Memory groups served in memory: Topics answering from a list, Memory with a
 * fixed status to read. Only these two are served, so another group gaining an endpoint never needs a handler here.
 */
const fakeOwner = () => {
  const topics: TopicView[] = []
  const Memory = HttpApiBuilder.group(OwnerApi, 'memory', (handlers) =>
    handlers.handle('status', () => Effect.succeed(MEMORY)),
  )
  const Topics = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.topics),
      create: ({ payload }) => {
        if (topics.some((topic) => topic.name.toLowerCase() === payload.name.toLowerCase()))
          return Effect.fail(new Conflict({ reason: 'topic_name_taken', ref: RAY }))
        const topic: TopicView = { ...PERSONAL, id: topics.length + 1, name: payload.name, personal: undefined }
        topics.push(topic)
        return Effect.succeed(topic)
      },
    }),
  )
  const gate = Layer.succeed(OwnerAdmission, (handler) => handler)
  const server = fakeHttpApi(
    ownerApiOf(TopicsGroup, MemoryGroup),
    Layer.mergeAll(Topics, Memory).pipe(Layer.provide(gate)),
  )
  return { ...server, reset: () => void topics.splice(0, topics.length, PERSONAL) }
}

const fake = fakeOwner()
/** What reached the fake since this test began. */
let seen = 0
const calls = () => fake.calls.slice(seen)
// The app's client is same-origin and built once: it resolves paths against the page and calls the global fetch.
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => {
  fake.reset()
  seen = fake.calls.length
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

const createTopic = owner.apiMutation({
  mutationFn: (api, input: CreateTopic) => api.topics.create({ payload: input }).pipe(withOperation(input.operationId)),
})

describe('the owner API bridge', () => {
  it('resolves a query through the contract, with a fresh request id and no CSRF header on a read', async () => {
    const client = testQueryClient()
    const memory = await client.query(
      owner.apiQuery({ queryKey: ['memory', 'status'], queryFn: (api) => api.memory.status({ query: {} }) }),
    )
    expect(memory).toEqual(MEMORY)
    const [request] = calls()
    expect(request?.headers.get('x-goblin-request')).toMatch(/^[0-9a-f]{8}$/u)
    expect(request?.headers.get('x-goblin-csrf')).toBeNull()
    expect(request?.headers.get('x-goblin-operation')).toBeNull()
  })

  it('surfaces a 409 as the typed Conflict with its reference, from a write that names its operation', async () => {
    const client = testQueryClient()
    const mutation = new MutationObserver(client, createTopic)
    await expect(mutation.mutate({ name: 'Garden', operationId: 'op-1' })).resolves.toMatchObject({ name: 'Garden' })
    const failure: unknown = await mutation
      .mutate({ name: 'garden', operationId: 'op-2' })
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Conflict)
    expect(failure).toMatchObject({ reason: 'topic_name_taken', ref: RAY })
    expect(describeError(failure)).toMatchObject({ kind: 'conflict', code: 'conflict', status: 409, ref: RAY })
    expect(messageOf(failure, 'create the topic')).toBe(`${ERROR_COPY.Conflict.message} · ref 7f3a9c12`)
    const write = calls().at(-1)
    expect(write?.headers.get('x-goblin-csrf')).toBe('1')
    expect(write?.headers.get('x-goblin-operation')).toBe('op-2')
    expect(write?.headers.get('x-goblin-request')).toMatch(/^[0-9a-f]{8}$/u)
  })

  it('quotes the request id it sent when no answer came back', async () => {
    const sent: Request[] = []
    const offline = makeApiQuery({
      id: 'test/OfflineOwnerApi',
      client: HttpApiClient.make(OwnerApi, { baseUrl: 'http://app.test' }),
      headers: { 'x-goblin-request': 'a1b2c3d4' },
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(new Request(input, init))
          throw new TypeError('Failed to fetch')
        },
        { preconnect: () => undefined },
      ),
    })
    const failure: unknown = await offline
      .run((api) => api.memory.status({ query: {} }))
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(sent).toHaveLength(1)
    expect(describeError(failure)).toMatchObject({ kind: 'unavailable', code: 'transport_error', ref: 'a1b2c3d4' })
    expect(messageOf(failure, 'load your memory')).toBe(
      'Could not load your memory. The service is not answering. Try again in a minute. · ref a1b2c3d4',
    )
    await offline.runtime.dispose()
  })

  it('turns an aborted query into a cancelled ApiDefect', async () => {
    const controller = new AbortController()
    controller.abort()
    const failure: unknown = await owner
      .run((api) => api.memory.status({ query: {} }), controller.signal)
      // expected: the test asserts on the failure it captures
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiDefect)
    expect(describeError(failure).kind).toBe('cancelled')
  })
})

describe('the error kinds of goblin codes', () => {
  const expected = {
    unauthenticated: 'unauthenticated',
    forbidden: 'forbidden',
    grant_denied: 'forbidden',
    not_found: 'not_found',
    conflict: 'conflict',
    invalid_input: 'validation',
    payload_too_large: 'validation',
    resident_inactive: 'forbidden',
    budget_exhausted: 'plan_limit',
    subscription_required: 'plan_limit',
    needs_authorization: 'forbidden',
    upstream_mcp: 'unavailable',
    internal: 'defect',
  } as const satisfies Record<ApiCode, ErrorKind>

  it.each(Object.entries(expected))('classifies %s as %s, from an envelope body', (code, kind) => {
    expect(ERROR_KINDS).toMatchObject({ [code]: kind })
    expect(describeError({ error: { code, message: 'x' } }).kind).toBe(kind)
  })
})
