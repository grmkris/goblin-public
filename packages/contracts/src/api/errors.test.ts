import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { afterAll, describe, expect, it } from 'vitest'
import {
  API_ERRORS,
  ApiErrors,
  type ApiCode,
  type AppError,
  BudgetExhausted,
  Conflict,
  ERROR_COPY,
  Forbidden,
  GrantDenied,
  Internal,
  InvalidInput,
  NeedsAuthorization,
  NotFound,
  PayloadTooLarge,
  ResidentInactive,
  SubscriptionRequired,
  Unauthenticated,
  UpstreamMcp,
  codeOf,
  envelopeOf,
  statusOf,
} from './errors.ts'

/** One of every failure, with its HTTP status as the runtime has always answered it (`http/respond.ts`). */
const CASES: readonly (readonly [AppError, number])[] = [
  [new Unauthenticated({ reason: 'session' }), 401],
  [new Forbidden({ reason: 'csrf' }), 403],
  [new GrantDenied({ serverId: 'myplan', name: 'search' }), 403],
  [new NotFound({ what: 'topic' }), 404],
  [new Conflict({ reason: 'topic_name_taken', ref: '7f3a9c12' }), 409],
  [new InvalidInput({ reason: 'personal_topic' }), 400],
  [new PayloadTooLarge({ limit: 65_536 }), 413],
  [new ResidentInactive({ state: 'revoked' }), 409],
  [new BudgetExhausted({ limit: 1000, resetsAt: 86_400 }), 429],
  [new SubscriptionRequired({ subscribe: '/subscribe' }), 402],
  [new NeedsAuthorization({ serverId: 'myplan' }), 409],
  [new UpstreamMcp({ serverId: 'myplan', reason: 'remote-rpc', code: -32_601 }), 502],
  [new UpstreamMcp({ serverId: 'myplan', reason: 'timeout' }), 504],
  [new Internal({ reason: 'unexpected' }), 500],
]

/** An API whose one endpoint fails with the case it is asked for, served and called through real HttpApi encoding. */
const Probe = HttpApi.make('probe').add(
  HttpApiGroup.make('probe').add(
    HttpApiEndpoint.post('fail', '/fail', { payload: Schema.Struct({ index: Schema.Int }), error: API_ERRORS }),
  ),
)
const ProbeHandlers = HttpApiBuilder.group(Probe, 'probe', (handlers) =>
  handlers.handle('fail', ({ payload }) => {
    const failure = CASES[payload.index]?.[0]
    return failure === undefined ? Effect.die('no such case') : Effect.fail(failure)
  }),
)
const server = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Probe).pipe(Layer.provide(ProbeHandlers), Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)
afterAll(() => server.dispose())
const call = (index: number) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Probe, { baseUrl: 'http://probe.test' })
    return yield* client.probe.fail({ payload: { index } })
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => server.handler(new Request(input, init))),
  )

describe('the API error envelope', () => {
  it.each(CASES.map(([error, status], index) => [error._tag, status, index] as const))(
    'answers %s with %i and the client decodes the same failure',
    async (_tag, status, index) => {
      const [error] = CASES[index] ?? []
      const response = await server.handler(
        new Request('http://probe.test/fail', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index }),
        }),
      )
      expect(response.status).toBe(status)
      if (error === undefined) return
      expect(statusOf(error)).toBe(status)
      const body: unknown = await response.json()
      expect(body).toEqual(envelopeOf(error))
      expect(body).toMatchObject({ error: { code: codeOf(error._tag), message: ERROR_COPY[error._tag].message } })
      expect(await Effect.runPromise(Effect.flip(call(index)))).toEqual(error)
    },
  )

  it('names every code as its tag in lower_snake_case, as its type spells it', () => {
    const notFound: 'not_found' = codeOf('NotFound')
    const upstream: ApiCode = codeOf('UpstreamMcp')
    expect([notFound, upstream, codeOf('NeedsAuthorization')]).toEqual([
      'not_found',
      'upstream_mcp',
      'needs_authorization',
    ])
  })

  it('carries safe detail fields only, with the remote JSON-RPC code as rpcCode', () => {
    expect(envelopeOf(new UpstreamMcp({ serverId: 'myplan', reason: 'remote-rpc', code: -32_601 }))).toEqual({
      error: {
        code: 'upstream_mcp',
        message: 'The MCP server did not respond as expected.',
        serverId: 'myplan',
        reason: 'remote-rpc',
        rpcCode: -32_601,
      },
    })
    expect(envelopeOf(new Conflict({ reason: 'topic_name_taken', ref: '7f3a9c12' }))).toEqual({
      error: {
        code: 'conflict',
        message: 'That clashes with something that is already there.',
        recovery: 'Refresh and try again.',
        reason: 'topic_name_taken',
        ref: '7f3a9c12',
      },
    })
  })

  it('refuses a body whose code another status answers', () => {
    const conflict = envelopeOf(new Conflict({ reason: 'x' }))
    expect(Exit.isFailure(Schema.decodeUnknownExit(ApiErrors.notFound)(conflict))).toBe(true)
    expect(Exit.isSuccess(Schema.decodeUnknownExit(ApiErrors.conflict)(conflict))).toBe(true)
  })
})
