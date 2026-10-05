import { Effect, FileSystem, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { expect, test } from 'vitest'
import { relay } from '../scripts/relay.ts'
import { starterManifest } from '../src/manifest.ts'

// Injected transport and ledger validate admission only, never benchmark quality.
test('preflight subceiling stays inside the shared durable allowance', async () => {
  const fs = ledgerLayer()
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

test('provider reservation breach halts admission durably and keeps the actual upstream receipt', async () => {
  const fs = ledgerLayer()
  const manifest = starterManifest()
  const resolved = {
    manifest,
    sourceHash: '',
    corpusHash: '',
    runId: 'breach-test',
    mode: 'fake' as const,
    createdAt: '',
  }
  const round = () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* relay(resolved, 'attempts', undefined)
        provider.setScope('writer', 'build')
        const response = yield* Effect.promise(() =>
          fetch(`${provider.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bench-scope': 'writer', connection: 'close' },
            body: JSON.stringify({
              model: 'glm-5.3',
              messages: [{ role: 'user', content: 'Admission check' }],
              max_tokens: 5,
            }),
          }),
        )
        expect(response.status).toBe(402)
        yield* Effect.promise(() => response.text())
        expect(provider.totals()).toEqual({ requests: 1, input: 20, output: 10 })
        const settled = provider.traces('writer')
        expect(settled).toHaveLength(1)
        expect(settled[0]).toMatchObject({ status: 200, output: 10, reservedOutput: 5, reservationBreach: true })
      }),
    ).pipe(Effect.provide(Layer.merge(fs, FetchHttpClient.layer)))
  await Effect.runPromise(round())
  await Effect.runPromise(round())
})

test('answer attempt ceiling survives restart, counts each attempt once, and isolates other answers', async () => {
  const fs = ledgerLayer()
  const base = starterManifest()
  const resolved = {
    manifest: { ...base, allowance: { ...base.allowance, maxRequestsPerAnswer: 2 } },
    sourceHash: '',
    corpusHash: '',
    runId: 'answer-limit-test',
    mode: 'fake' as const,
    createdAt: '',
  }
  const round = (resume: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* relay(resolved, 'attempts', undefined)
        const send = (scope: string) =>
          Effect.promise(() =>
            fetch(`${provider.url}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-bench-scope': scope, connection: 'close' },
              body: JSON.stringify({
                model: 'glm-5.3',
                messages: [{ role: 'user', content: 'Admission check' }],
                max_tokens: 20,
              }),
            }),
          )
        provider.setScope('looping-answer', 'answer')
        if (!resume) {
          expect((yield* send('looping-answer')).status).toBe(200)
          expect((yield* send('looping-answer')).status).toBe(200)
        }
        expect((yield* send('looping-answer')).status).toBe(402)
        expect(provider.totals().requests).toBe(resume ? 3 : 2)
        if (!resume) {
          provider.setScope('another-answer', 'answer')
          expect((yield* send('another-answer')).status).toBe(200)
        }
      }),
    ).pipe(Effect.provide(Layer.merge(fs, FetchHttpClient.layer)))
  await Effect.runPromise(round(false))
  await Effect.runPromise(round(true))
})

function ledgerLayer() {
  const files = new Map<string, string>()
  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ''),
    writeFileString: (path, content, options) =>
      Effect.sync(() => {
        files.set(path, `${options?.flag === 'a' ? (files.get(path) ?? '') : ''}${content}`)
      }),
  })
  return fs
}

test('stage and phase limits restore independently without charging denied requests', async () => {
  const fs = ledgerLayer()
  const base = starterManifest()
  const limits = { maxRequests: 2, maxInputTokens: 10000, maxOutputTokens: 100 }
  const resolved = {
    manifest: {
      ...base,
      allowance: {
        ...base.allowance,
        phases: { preflight: limits, build: limits, answer: limits },
        stages: [22, 32].map((cutoff) => ({ cutoff, build: limits, answer: { ...limits, maxRequests: 1 } })),
      },
    },
    sourceHash: '',
    corpusHash: '',
    runId: 'stage-limit-test',
    mode: 'fake' as const,
    createdAt: '',
  }
  const round = (resume: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* relay(resolved, 'attempts', undefined)
        const send = (scope: string) =>
          Effect.promise(() =>
            fetch(`${provider.url}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-bench-scope': scope, connection: 'close' },
              body: JSON.stringify({
                model: 'glm-5.3',
                messages: [{ role: 'user', content: 'Admission check' }],
                max_tokens: 20,
              }),
            }),
          )
        provider.setScope('missing-stage', 'answer')
        expect((yield* send('missing-stage')).status).toBe(402)
        provider.setScope('first', 'answer', 22)
        if (!resume) expect((yield* send('first')).status).toBe(200)
        const before = provider.totals()
        expect((yield* send('first')).status).toBe(402)
        expect(provider.totals()).toEqual(before)
        provider.setScope('later', 'answer', 32)
        if (!resume) expect((yield* send('later')).status).toBe(200)
        provider.setScope('build', 'build', 22)
        if (!resume) expect((yield* send('build')).status).toBe(200)
        expect(provider.totals().requests).toBe(3)
      }),
    ).pipe(Effect.provide(Layer.merge(fs, FetchHttpClient.layer)))
  await Effect.runPromise(round(false))
  await Effect.runPromise(round(true))
})
