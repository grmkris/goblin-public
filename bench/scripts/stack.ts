import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect } from 'effect'
import { fileURLToPath } from 'node:url'

export default Alchemy.Stack(
  'goblinMemoryBench',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const port = yield* Config.Port('GOBLIN_BENCH_PORT').pipe(Config.withDefault(18872))
    const relay = yield* Config.String('GOBLIN_BENCH_RELAY').pipe(Config.withDefault('http://127.0.0.1:18873/v1'))
    const worker = yield* Cloudflare.Worker('MemoryBench', {
      main: fileURLToPath(new URL('../worker/worker.ts', import.meta.url)),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port, strictPort: true },
      env: { BENCH: Cloudflare.DurableObject('BenchmarkAgent'), RELAY_URL: relay },
    })
    return { url: worker.url.as<string>() }
  }),
)
