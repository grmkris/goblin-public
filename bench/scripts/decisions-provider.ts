import { Config, DateTime, Effect, Option, Redacted, Schema, Layer } from 'effect'
import { BunServices } from '@effect/platform-bun'
import { FetchHttpClient } from 'effect/http'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { fail, type BenchError } from './store.ts'
import type { Model } from '../src/decisions/manifest.ts'

export interface Reply {
  readonly status: number
  readonly text: string
  readonly latencyMs: number
  readonly error: string | null
}
export interface Request {
  readonly model: Model
  readonly body: string
}
export type Provider = (request: Request) => Effect.Effect<Reply, BenchError>

/** Credential values never enter the packet, manifest, trace or error channel. */
export const liveProvider = Effect.fn('decisions.provider')(function* (request: Request) {
  const client = yield* HttpClient.HttpClient
  const token = yield* Config.option(Config.Redacted(request.model.keyEnv))
  if (Option.isNone(token)) return { status: 0, text: '', latencyMs: 0, error: 'missing-credential' }
  const started = DateTime.toEpochMillis(yield* DateTime.now)
  const headers =
    request.model.arm === 'jev'
      ? {
          'ai-gateway-protocol-version': '0.0.1',
          'ai-evaluation-model-specification-version': '4',
          'ai-model-id': request.model.model,
          'ai-gateway-auth-method': 'api-key',
        }
      : {}
  const send = client
    .execute(
      HttpClientRequest.post(request.model.endpoint).pipe(
        HttpClientRequest.bearerToken(token.value),
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyText(request.body, 'application/json'),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.map((text) => ({
            status: response.status,
            text,
            error: response.status >= 200 && response.status < 300 ? null : 'http-' + response.status,
          })),
        ),
      ),
      Effect.catch(() => Effect.succeed({ status: 0, text: '', error: 'provider-error' })),
      Effect.timeoutOption('30 seconds'),
    )
  const result = yield* send
  const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - started
  return Option.isNone(result)
    ? { status: 0, text: '', latencyMs: elapsed, error: 'timeout' }
    : { ...result.value, latencyMs: elapsed }
})

export const configuredProvider: Provider = (request) =>
  liveProvider(request).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
    Effect.mapError(() => fail('Provider transport failed')),
  )

export const discoverAccount = Effect.fn('decisions.account')(function* () {
  const client = yield* HttpClient.HttpClient
  const token = yield* Config.option(Config.Redacted('CLOUDFLARE_AI_TOKEN'))
  if (Option.isNone(token)) return { account: 'unavailable', status: 0 }
  const response = yield* client.execute(
    HttpClientRequest.get('https://api.cloudflare.com/client/v4/accounts').pipe(
      HttpClientRequest.bearerToken(Redacted.value(token.value)),
    ),
  )
  if (response.status !== 200) return { account: 'unavailable', status: response.status }
  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ result: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  )(yield* response.json)
  return { account: body.result[0]?.id ?? 'unavailable', status: response.status }
})
export const parseJson = (text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => fail('Malformed provider JSON') })
