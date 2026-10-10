import { AppsGroup, McpGroup, NotFound, OwnerApi, OwnerAdmission, ownerApiOf } from '@goblin/contracts/api'
import type { AppLaunch } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../src/lib/api.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import {
  allowAppToolMutation,
  appCallMutation,
  appDiagnosticMutation,
  appLaunchQuery,
  appResourceReadMutation,
  appStateQuery,
  appToolCallMutation,
  perform,
} from '../src/apps/queries.ts'
import { unusedHandlers } from './query/unused-handlers.ts'

const LAUNCH: AppLaunch = {
  kind: 'agent',
  name: 'tapper',
  release: 'r_1',
  revision: 2,
  state: { n: 2 },
  ui: { module: '', css: '', libs: [] },
}
const OP = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'

/** The real contract's Apps and MCP groups, answering one agent app and one MCP server. */
const fakeApps = () => {
  let revision = 2
  const reports: string[] = []
  const callers: Array<string | undefined> = []
  const apps = HttpApiBuilder.group(OwnerApi, 'apps', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.apps),
      launch: ({ params }) =>
        params.id === '7'
          ? Effect.succeed({ ...LAUNCH, revision })
          : Effect.fail(new NotFound({ what: 'app', ref: 'ray-404' })),
      state: () => Effect.succeed({ revision, release: 'r_1', state: { n: revision } }),
      call: ({ payload }) => {
        revision += 1
        return Effect.succeed({ ok: true as const, revision, release: 'r_1', state: { n: revision, by: payload.op } })
      },
      diagnostics: ({ payload }) => {
        reports.push(payload.message)
        return Effect.succeed({ kept: true })
      },
    }),
  )
  const mcp = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
    handlers.handleAll({
      ...unusedHandlers(OwnerApi.groups.mcp),
      grants: () => Effect.succeed([]),
      setToolGrant: ({ payload }) =>
        Effect.succeed([{ serverId: payload.serverId, capability: 'tool' as const, name: payload.name }]),
      callTool: ({ headers, payload }) => {
        callers.push(headers['x-mcp-caller'])
        return Effect.succeed({ content: [{ type: 'text', text: payload.name }], extra: 'kept' })
      },
      readResource: ({ headers, payload }) => {
        callers.push(headers['x-mcp-caller'])
        return Effect.succeed({ contents: [{ uri: payload.uri, text: '<p>App</p>' }] })
      },
    }),
  )
  const gate = Layer.succeed(OwnerAdmission, (handler) => handler)
  const server = fakeHttpApi(ownerApiOf(AppsGroup, McpGroup), Layer.mergeAll(apps, mcp).pipe(Layer.provide(gate)))
  return {
    ...server,
    reports,
    callers,
    reset: () => {
      revision = 2
      reports.length = 0
      callers.length = 0
    },
  }
}

const fake = fakeApps()
let seen = 0
const calls = () => fake.calls.slice(seen).map((request) => `${request.method} ${new URL(request.url).pathname}`)
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

describe("an App's frame calls", () => {
  it('launch and read state fresh every time, never from the cache', async () => {
    const client = testQueryClient()
    expect(await client.query(appLaunchQuery('7'))).toEqual(LAUNCH)
    await perform(client, appCallMutation, { id: '7', call: { name: 'tap', arguments: {}, op: OP } })
    expect(await client.query(appLaunchQuery('7'))).toMatchObject({ revision: 3 })
    expect(await client.query(appStateQuery('7'))).toEqual({ revision: 3, release: 'r_1', state: { n: 3 } })
    expect(await client.query(appStateQuery('7'))).toMatchObject({ revision: 3 })
    expect(calls()).toEqual([
      'GET /api/apps/7/launch',
      'POST /api/apps/7/call',
      'GET /api/apps/7/launch',
      'GET /api/apps/7/state',
      'GET /api/apps/7/state',
    ])
  })

  it("carry an agent app's report and an MCP App's calls, the latter as the App", async () => {
    const client = testQueryClient()
    await perform(client, appDiagnosticMutation, { id: '7', message: 'TypeError: boom' })
    expect(fake.reports).toEqual(['TypeError: boom'])
    const result = await perform(client, appToolCallMutation, { serverId: 'myplan', call: { name: 'read' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'read' }], extra: 'kept' })
    await perform(client, appResourceReadMutation, { serverId: 'myplan', read: { uri: 'ui://myplan/app' } })
    expect(fake.callers).toEqual(['app', 'app'])
  })

  it('allow the asked tool and read the MCP queries again', async () => {
    const client = testQueryClient()
    await client.query(owner.apiQuery({ queryKey: ['mcp', 'grants'], queryFn: (api) => api.mcp.grants() }))
    const grants = await perform(client, allowAppToolMutation(client), { serverId: 'myplan', name: 'read' })
    expect(grants).toEqual([{ serverId: 'myplan', capability: 'tool', name: 'read' }])
    expect(client.getQueryState(['mcp', 'grants'])?.isInvalidated).toBe(true)
  })

  it('fail with the typed refusal the owner sees', async () => {
    const client = testQueryClient()
    await expect(client.query(appLaunchQuery('8'))).rejects.toBeInstanceOf(NotFound)
  })
})
