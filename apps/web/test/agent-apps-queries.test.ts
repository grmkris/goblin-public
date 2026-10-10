import { AgentAppsGroup, NotFound, OwnerApi, OwnerAdmission, ownerApiOf } from '@goblin/contracts/api'
import type { AgentAppChange, AgentAppDetail } from '@goblin/contracts'
import { MutationObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../src/lib/api.ts'
import { messageOf } from '../src/lib/query/app-error.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import {
  agentAppQuery,
  agentAppsQuery,
  changeAgentAppMutation,
  deleteAgentAppMutation,
} from '../src/agent-apps/queries.ts'

const TRACKER: AgentAppDetail = {
  name: 'tracker',
  title: 'Tracker',
  description: 'Tracks things.',
  home: '1',
  app: '7',
  version: 1,
  revision: 3,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 1,
  releases: [{ release: 'r_1', version: 1, status: 'active', note: null, at: 1 }],
  powers: [],
  usage: { egress: 0, tokens: 0, notify: 0, job: 0 },
  files: { count: 0, bytes: 0 },
  events: [],
}

/** An app as the list shows it: the detail's own fields left out. */
const summaryOf = ({ releases: _r, powers: _p, usage: _u, files: _f, events: _e, ...summary }: AgentAppDetail) =>
  summary

const missing = () => new NotFound({ what: 'agent app', ref: 'ray-404' })

/** The real contract's agent apps group, answering from one app; only this group is served. */
const fakeAgentApps = () => {
  let apps: AgentAppDetail[] = []
  const changes: AgentAppChange[] = []
  const group = HttpApiBuilder.group(OwnerApi, 'agentApps', (handlers) =>
    handlers
      .handle('list', () => Effect.succeed(apps))
      .handle('detail', ({ params }) => {
        const app = apps.find((each) => each.name === params.name)
        return app === undefined ? Effect.fail(missing()) : Effect.succeed(app)
      })
      .handle('change', ({ params, payload }) => {
        const app = apps.find((each) => each.name === params.name)
        if (app === undefined) return Effect.fail(missing())
        changes.push(payload)
        const changed = { ...app, revision: app.revision + 1 }
        apps = apps.map((each) => (each.name === params.name ? changed : each))
        return Effect.succeed(changed)
      })
      .handle('delete', ({ params, payload }) => {
        if (payload.confirm !== params.name) return Effect.fail(missing())
        apps = apps.filter((each) => each.name !== params.name)
        return Effect.succeed({ deleted: params.name })
      }),
  )
  const gate = Layer.succeed(OwnerAdmission, (handler) => handler)
  const server = fakeHttpApi(ownerApiOf(AgentAppsGroup), group.pipe(Layer.provide(gate)))
  return {
    ...server,
    changes,
    reset: () => {
      apps = [TRACKER]
      changes.length = 0
    },
  }
}

const fake = fakeAgentApps()
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

describe('the agent apps factories', () => {
  it('read the list and one app through the contract', async () => {
    const client = testQueryClient()
    expect(await client.query(agentAppsQuery)).toEqual([summaryOf(TRACKER)])
    expect(await client.query(agentAppQuery('tracker'))).toEqual(TRACKER)
    expect(calls()).toEqual(['GET /api/agent-apps', 'GET /api/agent-apps/tracker'])
  })

  it('keep the changed app as answered and read the list again', async () => {
    const client = testQueryClient()
    await client.query(agentAppsQuery)
    await client.query(agentAppQuery('tracker'))
    const change = new MutationObserver(client, changeAgentAppMutation(client, 'tracker'))
    const changed = await change.mutate({ kind: 'pause', action: 'sync', paused: true })
    expect(fake.changes).toEqual([{ kind: 'pause', action: 'sync', paused: true }])
    expect(client.getQueryData(agentAppQuery('tracker').queryKey)).toEqual(changed)
    expect(client.getQueryState(agentAppsQuery.queryKey)?.isInvalidated).toBe(true)
    expect(calls()).toEqual(['GET /api/agent-apps', 'GET /api/agent-apps/tracker', 'POST /api/agent-apps/tracker'])
  })

  it('delete with the typed name, and a refusal reads as the owner sees it', async () => {
    const client = testQueryClient()
    const remove = new MutationObserver(client, deleteAgentAppMutation(client, 'tracker'))
    const refused = await remove.mutate('trackr').then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(refused).toBeInstanceOf(NotFound)
    expect(messageOf(refused, 'delete the app')).toBe('That does not exist. · ref ray-404')
    expect(await remove.mutate('tracker')).toEqual({ deleted: 'tracker' })
    expect(await client.query(agentAppsQuery)).toEqual([])
  })
})
