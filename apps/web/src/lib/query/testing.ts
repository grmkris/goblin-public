import * as Layer from 'effect/Layer'
import type * as HttpApi from 'effect/http-api/HttpApi'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import { makeQueryClient } from './api-query.ts'

/** A recorded request; typed from `clone()` so it matches the DOM, Bun and Workers `Request` types alike. */
export type RecordedRequest = ReturnType<Request['clone']>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
/** Bun's and the Workers' `fetch` types add members (`preconnect`); the fakes implement the call only. */
const asFetch = (call: FetchLike): typeof globalThis.fetch => Object.assign(call, { preconnect: () => undefined })
const requestOf = (input: RequestInfo | URL, init?: RequestInit): Request =>
  new Request(input instanceof Request ? input : new URL(String(input), 'http://app.test'), init)

/** In-memory HttpApi server. Its schemas encode success and typed refusals exactly as production does. */
export function fakeHttpApi<Id extends string, Groups extends HttpApiGroup.Constraint, E>(
  api: HttpApi.HttpApi<Id, Groups>,
  groupLayers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, E>,
) {
  const appLayer: Layer.Layer<never, E, HttpRouter.HttpRouter> = HttpApiBuilder.layer(api).pipe(
    Layer.provide(groupLayers),
    Layer.provide(HttpServer.layerServices),
  )
  const web = HttpRouter.toWebHandler(appLayer, { disableLogger: true })
  const calls: RecordedRequest[] = []
  const fetch = asFetch((input, init) => {
    const request = requestOf(input, init)
    calls.push(request.clone())
    return web.handler(request)
  })
  return { fetch, calls, dispose: web.dispose }
}

/** Fresh cache per test that never retries; `signIns` counts the expiry callback's calls. */
export function testQueryClient() {
  const signIns = { count: 0 }
  const client = makeQueryClient({
    onUnauthenticated: () => {
      signIns.count += 1
    },
  })
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } })
  return Object.assign(client, { signIns })
}
