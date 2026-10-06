import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Core'
import { Effect } from 'effect'
import Stack from './stack.ts'
import { serveLocal } from './http-server.ts'

function prepareEnvironment() {
  const saved = [process.env['CLOUDFLARE_ACCOUNT_ID'], process.env['CLOUDFLARE_API_TOKEN']]
  process.env['CLOUDFLARE_ACCOUNT_ID'] = '00000000000000000000000000000000'
  process.env['CLOUDFLARE_API_TOKEN'] = 'local-placeholder-token'
  return () => {
    for (const [index, key] of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].entries()) {
      const value = saved[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Local tooling boundary: force placeholder cloud credentials even in an authenticated interactive shell. */
export const localStack = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const restore = yield* Effect.sync(prepareEnvironment)
  yield* Effect.addFinalizer(() => Effect.sync(restore))
  const options = {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
    stage: 'memory_bench_local',
    dev: true,
  }
  return yield* Test.toEffect(Test.deploy(options, Stack, { scope }), options, scope)
})

/** Test-only overrides: route workerd to its fake relay, restoring the environment after teardown. */
export const localTestStack = Effect.fn('bench.localTestStack')(function* (relay: string) {
  // Reserve an independent worker port while the caller's fake relay stays bound.
  const workerPort = yield* Effect.acquireRelease(
    Effect.promise(() => serveLocal(0, async () => new Response(null, { status: 503 }))),
    (server) => Effect.promise(() => server.stop()),
  )
  const port = Number(new URL(workerPort.url).port)
  const keys = ['GOBLIN_BENCH_PORT', 'GOBLIN_BENCH_RELAY']
  const saved = keys.map((key) => process.env[key])
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const [index, key] of keys.entries()) {
        const value = saved[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }),
  )
  process.env['GOBLIN_BENCH_PORT'] = String(port)
  process.env['GOBLIN_BENCH_RELAY'] = relay
  yield* Effect.promise(() => workerPort.stop())
  return yield* localStack
})
