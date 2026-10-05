import { Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { expect, test } from 'vitest'
import { relay } from '../scripts/relay.ts'
import { starterManifest } from '../src/manifest.ts'

// Injected transport and ledger validate admission only, never benchmark quality.
test('preflight subceiling stays inside the shared durable allowance', async () => {
  const files = new Map<string, string>()
  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ''),
    writeFileString: (path, content, options) =>
      Effect.sync(() => {
        files.set(path, `${options?.flag === 'a' ? (files.get(path) ?? '') : ''}${content}`)
      }),
  })
  const manifest = {
    ...starterManifest(),
    allowance: { ...starterManifest().allowance, maxRequests: 2 },
    preflight: {
      scenarioId: 'staging',
      cutoff: 3,
      sourceId: 'owner',
      query: 'sidebar',
      maxRequests: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 25,
    },
  }
  const resolved = {
    manifest,
    sourceHash: '',
    corpusHash: '',
    runId: 'admission-test',
    mode: 'fake' as const,
    createdAt: '',
  }
  const round = (resume: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* relay(resolved, 'attempts', undefined)
        const send = () =>
          Effect.promise(async () =>
            fetch(`${provider.url}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-bench-scope': 'preflight', connection: 'close' },
              body: JSON.stringify({
                model: 'glm-5.3',
                messages: [{ role: 'user', content: 'Admission check' }],
                max_tokens: 20,
              }),
            }),
          )
        provider.setScope('preflight', 'preflight')
        if (!resume) expect((yield* send()).status).toBe(200)
        expect((yield* send()).status).toBe(402)
        if (!resume) {
          expect(provider.totals().requests).toBe(1)
          provider.setScope('preflight', 'answer')
          expect((yield* send()).status).toBe(200)
        }
        expect((yield* send()).status).toBe(402)
        expect(provider.totals()).toEqual({ requests: 2, input: 40, output: 20 })
      }),
    ).pipe(Effect.provide(Layer.merge(fs, FetchHttpClient.layer)))
  await Effect.runPromise(round(false))
  await Effect.runPromise(round(true))
})
