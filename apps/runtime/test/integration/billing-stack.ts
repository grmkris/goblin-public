import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect } from 'effect'
import { fileURLToPath } from 'node:url'
export default Alchemy.Stack(
  'goblinBillingHarness',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const port = (yield* Config.Port('GOBLIN_HARNESS_PORT')) + 10
    const auth = yield* Cloudflare.D1.Database('BillingAuth', {
      migrations: fileURLToPath(new URL('../../migrations', import.meta.url).href),
    })
    const worker = yield* Cloudflare.Worker('BillingWorker', {
      main: fileURLToPath(new URL('./billing-worker.ts', import.meta.url).href),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port, strictPort: true },
      env: {
        AGENTS: Cloudflare.DurableObject('BillingAgent'),
        AUTH_DB: auth,
        APP_URL: 'https://goblin.test',
        BETTER_AUTH_SECRET: 'fixture-billing-auth-secret-at-least-32-chars',
        SIGNUP_MODE: 'open',
        STAGE: 'test',
        MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
        MODEL_ID: 'storage-only',
        MODEL_KEY: 'unused-fixture',
        CREDENTIAL_KEY: 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE=',
      },
    })
    return { url: worker.url.as<string>() }
  }),
)
