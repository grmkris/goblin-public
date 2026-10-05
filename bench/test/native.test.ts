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
        const seen: unknown[] = []
        const relay = yield* Effect.promise(() =>
          serveLocal(18873, async (request) => {
            const body = Schema.decodeUnknownSync(ChatRequest)(await request.json())
            seen.push(body)
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
        for (const [at, policy] of ['optchat', 'standard'].entries()) {
          const actor = Math.abs(yield* Random.nextInt)
            .toString(16)
            .padStart(64, '0')
          const config = { identity: actor, manifest, policy, writer: 'glm-5.3', events }
          const built: unknown = yield* call(actor, 'build', config)
          expect(built).toMatchObject({ reused: false, head: policy === 'optchat' ? 'app.memory' : 'pi.compaction' })
          const result = yield* Schema.decodeUnknownEffect(ProbeResult)(
            yield* call(actor, 'probe', {
              id: `probe-${at}`,
              reader: 'deepseek-v4-pro-0813',
              question: 'What staging retry limit is approved?',
              search: policy === 'standard',
              cutoff: 64,
              recallGuide: null,
            }),
          )
          expect(result.status).toBe('done')
          const again: unknown = yield* call(actor, 'build', config)
          expect(again).toMatchObject({ reused: true })
          expect(JSON.stringify(result.context)).not.toContain('fact')
          expect(JSON.stringify(result.context)).not.toContain('staging.e300')
        }
        expect(seen.length).toBeGreaterThan(2)
      }),
    ),
  )
}, 240_000)
