import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { fileURLToPath } from 'node:url'
import { resolveStage } from '../../scripts/stage-config.ts'

const root = fileURLToPath(new URL('./', import.meta.url))

export default Alchemy.Stack(
  'Purrable',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = resolveStage(yield* Alchemy.Stage)
    const appUrl = yield* Config.String('PURRABLE_APP_URL').pipe(Config.withDefault('http://localhost:18971'))
    const db = yield* Cloudflare.D1.Database('PurrableAuth', {
      name: stage.resourceName('auth'),
      migrations: fileURLToPath(new URL('../../apps/runtime/migrations', import.meta.url)),
    })
    const agents = Cloudflare.DurableObject('PersonalAgent', { className: 'PersonalAgent' })
    const web = yield* Cloudflare.Website.Vite('Web', {
      name: stage.workerName,
      rootDir: root,
      main: 'src/worker.ts',
      workersDev: true,
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      dev: { port: 18971, strictPort: true },
      memo: {
        include: ['src/**', 'vite.config.ts', 'package.json', '../../apps/runtime/src/**', '../../packages/**'],
        lockfile: true,
      },
      env: {
        AGENTS: agents,
        AUTH_DB: db,
        APP_URL: appUrl,
        BETTER_AUTH_SECRET: Config.Redacted('PURRABLE_BETTER_AUTH_SECRET'),
        OWNER_EMAIL: Config.String('PURRABLE_OWNER_EMAIL').pipe(Config.withDefault('')),
        OWNER_BOOTSTRAP_TOKEN: Config.Redacted('PURRABLE_OWNER_BOOTSTRAP_TOKEN').pipe(
          Config.withDefault(Redacted.make('')),
        ),
        MODEL_BASE_URL: Config.String('PURRABLE_MODEL_BASE_URL').pipe(Config.withDefault('http://127.0.0.1:8317/v1')),
        MODEL_ID: Config.String('PURRABLE_MODEL_ID').pipe(Config.withDefault('gemini-3.8-flash')),
        MODEL_KEY: Config.Redacted('PURRABLE_MODEL_KEY').pipe(Config.withDefault(Redacted.make(''))),
        MCP_SERVERS: Config.String('PURRABLE_MCP_SERVERS').pipe(Config.withDefault('[]')),
        MCP_TOKENS: Config.Redacted('PURRABLE_MCP_TOKENS').pipe(Config.withDefault(Redacted.make('{}'))),
        STAGE: stage.local ? 'local' : stage.name === 'dev' ? 'dev' : 'test',
      },
    })
    return { url: web.url, authDatabase: db.databaseId }
  }),
)
