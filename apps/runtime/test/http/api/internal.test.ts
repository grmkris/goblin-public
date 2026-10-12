import { OwnerApi, ResidentGroup } from '@goblin/contracts/api'
import { InternalApi } from '@goblin/contracts/internal'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { describe, expect, it } from 'vitest'
import { ChatOperations, Chats, Conversations } from '../../../src/chats/service.ts'
import { Channel } from '../../../src/channel/service.ts'
import { routeNames } from '../../../src/http/api/context.ts'
import { InternalGateLive } from '../../../src/http/api/middleware.ts'
import { AgentHttp } from '../../../src/http/api/server.ts'
import { InboundHandlers } from '../../../src/inbound/api.ts'
import { Inspection } from '../../../src/inspect/service.ts'
import { Events, Resident } from '../../../src/mcp/service.ts'
import { Notices } from '../../../src/notices/service.ts'
import { ResidentHandlers } from '../../../src/mcp/resident-api.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { Changes } from '../../../src/runtime/changes.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { currentResident, get, plans, post, serve, served, stub, unrouted } from './fixture.ts'

/** The internal API as the agent serves it, behind the internal gate, over `handlers`. */
const servedInternal = <Handlers, R>(handlers: Layer.Layer<Handlers, never, R>) =>
  AgentHttp.serve(
    [routeNames(InternalApi)],
    HttpApiBuilder.layer(InternalApi).pipe(
      Layer.provide(handlers),
      Layer.provide(InternalGateLive),
      Layer.provide(HttpServer.layerServices),
    ),
  )

/** Handlers that only record which endpoint ran, so the gate is what the test sees. */
const recording = () => {
  const ran: string[] = []
  const mark = <A>(name: string, value: A) =>
    Effect.sync(() => {
      ran.push(name)
      return value
    })
  const handlers = HttpApiBuilder.group(InternalApi, 'inbound', (group) =>
    group
      .handle('ask', ({ payload }) => mark('ask', { status: 'running' as const, operationId: payload.operationId }))
      .handle('recent', () => mark('recent', []))
      .handle('doorbell', () => mark('doorbell', undefined))
      .handle('mcpEvents', () => mark('mcpEvents', { status: 204 as const }))
      .handle('inspect', () => mark('inspect', { conversations: [] }))
      .handle('billingNotice', () => mark('billingNotice', undefined)),
  )
  return { ran, handlers }
}

const ASK = { author: 'Claude', input: 'hello', operationId: 'op-1', waitMs: 0 }
const internal = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  body === undefined ? get(`/internal${path}`, headers) : post(`/internal${path}`, body, headers)

describe('the internal API served by the agent', () => {
  it('answers a request without the owner mark, after the plan check', async () => {
    const { ran, handlers } = recording()
    const { fetch } = serve(servedInternal(handlers).pipe(Layer.provide(plans())))
    const asked = await fetch(internal('/ask', ASK, { 'x-goblin-ref': 'ray-1' }))
    expect(asked.status).toBe(200)
    expect(await asked.json()).toEqual({ status: 'running', operationId: 'op-1' })
    expect((await fetch(internal('/recent?limit=5'))).status).toBe(200)
    expect(ran).toEqual(['ask', 'recent'])
  })

  it('refuses a request marked as the owner forward with the 404 envelope, before any handler runs', async () => {
    const { ran, handlers } = recording()
    const { fetch } = serve(servedInternal(handlers).pipe(Layer.provide(plans())))
    for (const request of [
      internal('/ask', ASK, { 'x-goblin-forwarded': 'owner', 'x-goblin-ref': 'ray-2' }),
      internal('/recent?limit=5', undefined, { 'x-goblin-forwarded': 'owner' }),
      internal('/inspect', { query: { kind: 'conversations' } }, { 'x-goblin-forwarded': '' }),
      internal('/nothing-here', {}),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    }
    expect(ran).toEqual([])
  })

  it('answers SubscriptionRequired without a plan on every endpoint but inspection', async () => {
    const { ran, handlers } = recording()
    const { fetch } = serve(servedInternal(handlers).pipe(Layer.provide(plans(false))))
    for (const request of [
      internal('/ask', ASK, { 'x-goblin-ref': 'ray-402' }),
      internal('/recent?limit=5'),
      internal('/doorbell', { body: '{}', timestamp: '0', signature: '' }),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(402)
      expect(await response.json()).toMatchObject({ error: { code: 'subscription_required' } })
    }
    const inspected = await fetch(internal('/inspect', { query: { kind: 'conversations' } }))
    expect(inspected.status).toBe(200)
    expect(ran).toEqual(['inspect'])
  })

  it('serves only its own prefix, and the owner API only its own', async () => {
    const { handlers } = recording()
    const internalOnly = serve(servedInternal(handlers).pipe(Layer.provide(plans())))
    expect(await unrouted(await internalOnly.fetch(get('/api/agent/resident')))).toBe(true)
    const resident = currentResident()
    const ownerOnly = serve(
      served([ResidentGroup], ResidentHandlers).pipe(
        Layer.provide(Layer.mergeAll(plans(), Layer.succeed(Resident, resident.service), stub(Events))),
      ),
    )
    const refused = await ownerOnly.fetch(internal('/recent?limit=5'))
    expect(refused.status).toBe(404)
    const ownerRoute = routeNames(OwnerApi)
    const internalRoute = routeNames(InternalApi)
    expect(ownerRoute(internal('/recent?limit=5'))).toBeUndefined()
    expect(internalRoute(get('/api/agent/resident'))).toBeUndefined()
    expect(internalRoute(get('/recent?limit=5'))).toBeUndefined()
  })
})

describe('the inbound handlers', () => {
  /** The real handlers over stubs: only the services a case names do anything. */
  const fixture = (parts: { readonly events?: Layer.Layer<Events>; readonly inspection?: Layer.Layer<Inspection> }) =>
    serve(
      servedInternal(InboundHandlers).pipe(
        Layer.provide(
          Layer.mergeAll(
            plans(),
            parts.events ?? stub(Events),
            parts.inspection ?? stub(Inspection),
            stub(Chats),
            stub(ChatOperations),
            stub(PiSessions),
            stub(Channel),
            stub(AgentInput),
            stub(Conversations),
            stub(Notices),
            stub(Changes),
            Layer.succeed(Resident, currentResident().service),
          ),
        ),
      ),
    )

  it("hands a connection's Events webhook bytes and signing headers to ingress, and answers its result", async () => {
    const seen: unknown[] = []
    const events = stub(Events, {
      receive: (input) =>
        Effect.sync(() => {
          seen.push(input)
          return { status: 200 as const, response: '{"ok":1}' }
        }),
    })
    const { fetch } = fixture({ events })
    const response = await fetch(
      new Request('https://agent/internal/mcp-events/sidequest-hirer', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-mcp-subscription-id': 'sub-1',
          'webhook-id': 'evt-1',
          'webhook-timestamp': '17',
          'webhook-signature': 'v1,sig',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(await response.json()).toEqual({ status: 200, response: '{"ok":1}' })
    expect(seen).toEqual([
      {
        connectionId: 'sidequest-hirer',
        body: new Uint8Array([1, 2, 3]),
        subscriptionId: 'sub-1',
        id: 'evt-1',
        timestamp: '17',
        signature: 'v1,sig',
      },
    ])
  })

  it('answers an inspection query with its result, and one that does not decode as invalid input', async () => {
    const inspection = stub(Inspection, { run: () => Effect.succeed({ conversations: [] }) })
    const { fetch } = fixture({ inspection })
    const answered = await fetch(internal('/inspect', { query: { kind: 'conversations' } }))
    expect(await answered.json()).toEqual({ conversations: [] })
    const invalid = await fetch(internal('/inspect', { query: { kind: 'everything' } }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })
})
