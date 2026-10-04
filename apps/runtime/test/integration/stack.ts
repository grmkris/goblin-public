import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { fileURLToPath } from 'node:url'

export default Alchemy.Stack(
  'PurrableNativeRuntimeHarness',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const port = yield* Config.Port('PURRABLE_HARNESS_PORT')
    const worker = yield* Cloudflare.Worker('PurrableNativeRuntimeHarnessWorker', {
      main: fileURLToPath(new URL('./worker.ts', import.meta.url).href),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port, strictPort: true },
      env: {
        AGENTS: Cloudflare.DurableObject('PersonalAgentProbe'),
        LIFECYCLE: Cloudflare.DurableObject('NativeLifecycleProbe'),
        MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
        MODEL_ID: 'storage-only',
        MODEL_KEY: 'unused-storage-fixture',
        APP_URL: 'https://purrable.test',
        // A fixed 32-byte test key: encrypts nothing real in this harness.
        CREDENTIAL_KEY: 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE=',
      },
    })
    return { url: worker.url.as<string>() }
  }),
)
