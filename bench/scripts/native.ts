import { Effect } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { fail } from './store.ts'

export const post = Effect.fn('bench.native')(function* (url: string, path: string, actor: string, body: unknown) {
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.post(`${url.replace(/\/+$/u, '')}/${path}?actor=${actor}`).pipe(
    HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'),
  )
  const response = yield* client.execute(request)
  if (response.status !== 200)
    return yield* fail(`Native ${path} failed with status ${response.status}: ${yield* response.text}`)
  return yield* response.json
})
