import type { ApprovalView } from '@goblin/contracts'
import { McpGroup, OwnerApi, OwnerGate, ownerApiOf } from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { approvalKeys, approvalQuery, decideApprovalMutation } from '../src/approvals/queries.ts'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'

const HELD: ApprovalView = {
  id: 'apr-1',
  serverId: 'notes',
  name: 'delete_note',
  arguments: { id: 'n-1' },
  state: 'pending',
  expiresAt: 100,
}

const unused = () => Effect.die('not used')

/** The real MCP group served in memory: one held call, and the owner's decision on it. */
const fakeOwner = () => {
  const state = { held: HELD }
  const Mcp = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
    handlers
      .handle('servers', unused)
      .handle('addServer', unused)
      .handle('suggested', unused)
      .handle('catalog', unused)
      .handle('registries', unused)
      .handle('addRegistry', unused)
      .handle('removeRegistry', unused)
      .handle('grants', unused)
      .handle('setToolGrant', unused)
      .handle('setAskFirst', unused)
      .handle('setSkills', unused)
      .handle('setAppGrant', unused)
      .handle('approval', () => Effect.succeed(state.held))
      .handle('decideApproval', ({ payload }) => {
        state.held = { ...state.held, state: payload.allowed ? 'approved' : 'refused' }
        return Effect.succeed(state.held)
      })
      .handle('tools', unused)
      .handle('connect', unused)
      .handle('disconnect', unused)
      .handle('removeServer', unused)
      .handle('callTool', unused)
      .handle('readResource', unused),
  )
  const gate = Layer.succeed(
    OwnerGate,
    OwnerGate.of((handler) => handler),
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
      const decide = new MutationObserver(client, decideApprovalMutation(client, 'apr-1'))
      await decide.mutate(false)
      expect(client.getQueryData(approvalKeys.detail('apr-1'))).toMatchObject({ state: 'refused' })
      expect(read.getCurrentResult().data?.state).toBe('refused')
    } finally {
      unsubscribe()
    }
  })
})
