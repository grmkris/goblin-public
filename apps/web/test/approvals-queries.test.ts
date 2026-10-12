import type { ApprovalView } from '@goblin/contracts'
import { McpGroup, OwnerApi, OwnerAdmission, ownerApiOf } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { approvalQuery, decideApprovalMutation } from '../src/approvals/queries.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const HELD: ApprovalView = {
  id: 'apr-1',
  connectionId: 'notes',
  name: 'delete_note',
  arguments: { id: 'n-1' },
  state: 'pending',
  expiresAt: 100,
}

/** The real MCP group served in memory: one held call, and the owner's decision on it. */
const fakeOwner = () => {
  const state = { held: HELD }
  const Mcp = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.mcp),
      approval: () => Effect.succeed(state.held),
      decideApproval: ({ payload }) => {
        state.held = { ...state.held, state: payload.allowed ? 'approved' : 'refused' }
        return Effect.succeed(state.held)
      },
    }),
  )
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => handler),
  )
  return fakeHttpApi(ownerApiOf(McpGroup), Mcp.pipe(Layer.provide(gate)))
}

const fake = fakeOwner()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('approval queries', () => {
  it('read a held call, and keep the decision the server answers as the call now stands', async () => {
    const client = testQueryClient()
    const read = new QueryObserver(client, approvalQuery('apr-1'))
    const unsubscribe = read.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(read.getCurrentResult().data?.state).toBe('pending'))
      const decide = new MutationObserver(client, decideApprovalMutation('apr-1'))
      await decide.mutate({ allowed: false })
      expect(client.getQueryData(approvalQuery('apr-1').queryKey)).toMatchObject({ state: 'refused' })
      expect(read.getCurrentResult().data?.state).toBe('refused')
    } finally {
      unsubscribe()
    }
  })
})
