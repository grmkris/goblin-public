import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Config, Effect } from 'effect'
import { fileURLToPath } from 'node:url'

export default Alchemy.Stack(
  'PurrableOwnerHarness',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const port = (yield* Config.Port('PURRABLE_HARNESS_PORT')) + 20
    const auth = yield* Cloudflare.D1.Database('OwnerAuth', {
      migrations: fileURLToPath(new URL('../../migrations', import.meta.url).href),
    })
    const worker = yield* Cloudflare.Worker('OwnerWorker', {
      main: fileURLToPath(new URL('./owner-worker.ts', import.meta.url).href),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port, strictPort: true },
      env: {
        AGENTS: Cloudflare.DurableObject('OwnerAgent'),
        AUTH_DB: auth,
        APP_URL: 'https://purrable.test',
        BETTER_AUTH_SECRET: 'fixture-owner-auth-secret-at-least-32-chars',
        SIGNUP_MODE: 'open',
        STAGE: 'test',
        MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
        MODEL_ID: 'storage-only',
        MODEL_KEY: 'unused-fixture',
        MCP_SERVERS: '[{"serverId":"apps-fixture","endpoint":"https://apps-fixture.test/mcp"}]',
        CREDENTIAL_KEY: 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE=',
      },
    })
    return { url: worker.url.as<string>() }
  }),
)
