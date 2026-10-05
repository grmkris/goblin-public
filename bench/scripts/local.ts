import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Core'
import { Effect } from 'effect'
import Stack from './stack.ts'

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
