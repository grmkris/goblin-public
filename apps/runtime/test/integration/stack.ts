import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { fileURLToPath } from 'node:url'

export default Alchemy.Stack(
  'goblinNativeRuntimeHarness',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const port = yield* Config.Port('GOBLIN_HARNESS_PORT')
    const files = yield* Cloudflare.R2.Bucket('NativeFiles')
    const auth = yield* Cloudflare.D1.Database('NativeAccountUsage', {
      migrations: fileURLToPath(new URL('../../migrations', import.meta.url).href),
    })
    const worker = yield* Cloudflare.Worker('goblinNativeRuntimeHarnessWorker', {
      main: fileURLToPath(new URL('./worker.ts', import.meta.url).href),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port, strictPort: true },
      env: {
        AGENTS: Cloudflare.DurableObject('PersonalAgentProbe'),
        AUTH_DB: auth,
        FILES: files,
        LOADER: Cloudflare.WorkerLoader(),
        LIFECYCLE: Cloudflare.DurableObject('NativeLifecycleProbe'),
        MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
        MODEL_ID: 'storage-only',
        MODEL_KEY: 'unused-storage-fixture',
        APP_URL: 'https://goblin.test',
        // A fixed 32-byte test key: encrypts nothing real in this harness.
        CREDENTIAL_KEY: 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE=',
      },
    })
    return { url: worker.url.as<string>() }
  }),
)
