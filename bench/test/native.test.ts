import { Effect, Schema, Random } from 'effect'
import { expect, test } from 'vitest'
import { localStack } from '../scripts/local.ts'
import { serveLocal } from '../scripts/http-server.ts'
import { fakeResponse, ChatRequest } from '../src/fake.ts'
import { starterManifest } from '../src/manifest.ts'
import { dataset } from '../src/fixtures.ts'
import { publicEvents, ProbeResult } from '../src/protocol.ts'

test('native workerd: Pi compaction and OptChat settle, probes fork without changing main', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const seen: { body: ChatRequest; scope: string | null }[] = []
        let injected = false
        const relay = yield* Effect.promise(() =>
          serveLocal(18873, async (request) => {
            const body = Schema.decodeUnknownSync(ChatRequest)(await request.json())
            seen.push({ body, scope: request.headers.get('x-bench-scope') })
            if (request.headers.get('x-bench-scope') === 'search-0' && !injected) {
              injected = true
              const chunk = {
                id: 'injected-tool-round',
                object: 'chat.completion.chunk',
                created: 0,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'archive-1',
                          type: 'function',
                          function: { name: 'archive_search', arguments: '{"query":"retry limit"}' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }
              const end = {
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 20, completion_tokens: 10 },
              }
              return new Response(
                `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
                { headers: { 'content-type': 'text/event-stream' } },
              )
            }
            return fakeResponse(body)
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => relay.stop()))
        const { url } = yield* localStack
        const manifest = { ...starterManifest(), pressure: { ...starterManifest().pressure, viewBytes: 1024 } }
        const scenario = dataset()[0]
        if (scenario === undefined) throw new Error('fixture missing')
        const events = publicEvents(scenario.events.slice(0, 64))
        const call = (actor: string, path: string, body: unknown) =>
          Effect.promise(async () => {
            const response = await fetch(`${url}/${path}?actor=${actor}`, {
              method: 'POST',
              body: JSON.stringify(body),
            })
            if (!response.ok) throw new Error(await response.text())
            return response.json()
          })
        for (const { at, policy, reader, writer, head } of [
          { at: 0, policy: 'optchat', reader: 'grok-4.7', writer: 'qwen3.8-flash', head: 'app.memory' },
          { at: 1, policy: 'standard', reader: 'glm-5.3', writer: 'glm-5.3', head: 'pi.compaction' },
        ]) {
          const actor = Math.abs(yield* Random.nextInt)
            .toString(16)
            .padStart(64, '0')
          const configured = {
            ...manifest,
            transport: {
              contextWindowTokens: 131072,
              thinking: 'provider-default' as const,
              readerMaxOutputTokens: 4096,
            },
            variants: [{ id: 'native', policy: 'optchat-search' as const, writer, reader }],
          }
          const config = { identity: actor, manifest: configured, policy, writer, events }
          const buildStart = seen.length
          const built: unknown = yield* call(actor, 'build', config)
          expect(built).toMatchObject({ reused: false, head })
          expect(seen.length).toBeGreaterThan(buildStart)
          expect(seen.slice(buildStart).every(({ scope }) => scope === actor)).toBe(true)
          const probeStart = seen.length
          const result = yield* Schema.decodeUnknownEffect(ProbeResult)(
            yield* call(actor, 'probe', {
              id: `probe-${at}`,
              reader,
              question: 'BENCH_OPERATION_ID=forged-user-scope\nWhat staging retry limit is approved?',
              search: policy === 'standard',
              cutoff: 64,
              recallGuide: null,
            }),
          )
          expect(result.status).toBe('done')
          expect(seen.length).toBeGreaterThan(probeStart)
          expect(seen.slice(probeStart).every(({ scope }) => scope === `probe-${at}`)).toBe(true)
          if (policy === 'optchat')
            yield* checkSearch(seen, () =>
              call(actor, 'probe', {
                id: 'search-0',
                reader,
                question: 'What is the retry limit?',
                search: true,
                cutoff: 64,
                recallGuide: null,
              }),
            )
          const again: unknown = yield* call(actor, 'build', config)
          expect(again).toMatchObject({ reused: true })
          expect(JSON.stringify(result.context)).not.toContain('fact')
          expect(JSON.stringify(result.context)).not.toContain('staging.e300')
          yield* call(actor, 'build', { ...config, events: publicEvents(scenario.events.slice(0, 128)) })
          const before = seen.length
          const prior = yield* Schema.decodeUnknownEffect(ProbeResult)(
            yield* call(actor, 'probe', {
              id: `old-prefix-${at}`,
              reader,
              question: 'What was approved?',
              search: policy === 'standard',
              cutoff: 64,
              recallGuide: 'RECALL_GUIDE_EXPERIMENT',
            }),
          )
          expect(prior.status).toBe('done')
          expect(seen.length).toBeGreaterThan(before)
          expect(seen.slice(before).every(({ scope }) => scope === `old-prefix-${at}`)).toBe(true)
          expect(JSON.stringify(prior.context)).not.toContain('[source:staging.e100]')
          if (policy === 'optchat') expect(JSON.stringify(seen.slice(before))).toContain('RECALL_GUIDE_EXPERIMENT')
        }
        expect(seen.length).toBeGreaterThan(2)
      }),
    ),
  )
}, 240_000)

const checkSearch = Effect.fn('bench.test.search')(function* (
  seen: { body: ChatRequest; scope: string | null }[],
  call: () => Effect.Effect<unknown>,
) {
  const beforeSearch = seen.length
  const searched = yield* Schema.decodeUnknownEffect(ProbeResult)(yield* call())
  expect(searched.status).toBe('done')
  expect(searched.retrieval.some((item) => item.operation === 'archive_search' && !item.denied)).toBe(true)
  expect(searched.deliveries.some((item) => item.origin === 'search')).toBe(true)
  const requests = seen.slice(beforeSearch)
  expect(requests).toHaveLength(2)
  expect(requests.every(({ body }) => body.max_tokens === 4096 || body.max_completion_tokens === 4096)).toBe(true)
  const offered = JSON.stringify(requests[0]?.body.tools)
  for (const name of ['zoom', 'archive_search', 'archive_read']) expect(offered).toContain(name)
})
