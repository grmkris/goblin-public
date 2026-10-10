import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { fileURLToPath } from 'node:url'
import { resolveStage } from '../../scripts/stage-config.ts'

const root = fileURLToPath(new URL('./', import.meta.url))

/** The model gateway, model choice and daily budget the Worker reads (docs/development.md). */
const modelEnv = {
  MODEL_BASE_URL: Config.String('GOBLIN_MODEL_BASE_URL').pipe(Config.withDefault('http://127.0.0.1:8317/v1')),
  MODEL_ID: Config.String('GOBLIN_MODEL_ID').pipe(Config.withDefault('gemini-3.8-flash')),
  MODELS: Config.String('GOBLIN_MODELS').pipe(Config.withDefault('')),
  MODEL_KEY: Config.Redacted('GOBLIN_MODEL_KEY').pipe(Config.withDefault(Redacted.make(''))),
  MODEL_CREDIT_RATES: Config.String('GOBLIN_MODEL_CREDIT_RATES').pipe(Config.withDefault('')),
  MEMORY_MODEL: Config.String('GOBLIN_MEMORY_MODEL').pipe(Config.withDefault('')),
}

/** What the Website build reads: a change to any of them builds again. */
const BUILD_INPUTS = [
  'src/**',
  'vite.config.ts',
  'vite.react.ts',
  'package.json',
  '../../apps/runtime/src/**',
  '../../packages/**',
]

const runtimeStage = (name: string) => (name === 'local' || name === 'dev' || name === 'prod' ? name : 'test')

export default Alchemy.Stack(
  'goblin',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = resolveStage(yield* Alchemy.Stage)
    const appUrl = yield* Config.String('GOBLIN_APP_URL').pipe(Config.withDefault('http://localhost:18971'))
    const domain = yield* Config.String('GOBLIN_DOMAIN').pipe(Config.withDefault(''))
    const zoneId = domain === '' ? '' : yield* Config.String('GOBLIN_ZONE_ID')
    const signupMode = yield* Config.String('GOBLIN_SIGNUP_MODE').pipe(Config.withDefault('closed'))
    const build = yield* Config.String('VITE_GOBLIN_BUILD').pipe(Config.withDefault(''))
    // An address on a domain onboarded for Cloudflare Email Sending; local uses its mail simulator.
    const mailSender = yield* Config.String('GOBLIN_MAIL_SENDER').pipe(
      Config.withDefault(stage.local ? 'hello@goblin.test' : ''),
    )
    if (mailSender === '') return yield* Effect.die(new Error('OTP login requires GOBLIN_MAIL_SENDER'))
    if (stage.name === 'dev' && signupMode === 'open')
      return yield* Effect.die(new Error('dev_sign_up_must_be_closed_or_invite_only'))
    const billingEnvironment = yield* Config.String('DODO_PAYMENTS_ENVIRONMENT').pipe(
      Config.withDefault(stage.name === 'prod' ? 'live_mode' : 'test_mode'),
    )
    if ((stage.name === 'prod') !== (billingEnvironment === 'live_mode'))
      return yield* Effect.die(new Error('Dodo stage and billing mode must match'))
    const db = yield* Cloudflare.D1.Database('goblinAuth', {
      name: stage.resourceName('auth'),
      migrations: fileURLToPath(new URL('../../apps/runtime/migrations', import.meta.url)),
    })
    const files = yield* Cloudflare.R2.Bucket('Files', { name: stage.resourceName('files') })
    // Conversation flows across every agent, one point per operation with a hashed agent id (ADR 0037).
    const flows = yield* Cloudflare.AnalyticsEngine.Dataset('Flows', { dataset: stage.resourceName('flows') })
    const agents = Cloudflare.DurableObject('PersonalAgent', { className: 'PersonalAgent' })
    const web = yield* Cloudflare.Website.Vite('Web', {
      name: stage.workerName,
      rootDir: root,
      main: 'src/worker.ts',
      workersDev: true,
      crons: ['17 * * * *'],
      ...(domain === ''
        ? {}
        : {
            domain: {
              name: domain,
              zoneId,
              ...(stage.name === 'prod' ? { aliases: [`www.${domain}`] } : {}),
            },
          }),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      observability: stage.observability,
      dev: { port: 18971, strictPort: true },
      memo: {
        include: BUILD_INPUTS,
        lockfile: true,
      },
      env: {
        AGENTS: agents,
        AUTH_DB: db,
        FILES: files,
        FLOWS: flows,
        LOADER: Cloudflare.WorkerLoader(),
        APP_URL: appUrl,
        BETTER_AUTH_SECRET: Config.Redacted('GOBLIN_BETTER_AUTH_SECRET'),
        SIGNUP_MODE: signupMode,
        ...(mailSender === ''
          ? {}
          : {
              MAIL: Cloudflare.Email.SendEmail('Mail', { allowedSenderAddresses: [mailSender] }),
              MAIL_SENDER: mailSender,
            }),
        SIGNUP_INVITE_CODE: Config.Redacted('GOBLIN_SIGNUP_INVITE_CODE').pipe(Config.withDefault(Redacted.make(''))),
        ...modelEnv,
        MCP_SERVERS: Config.String('GOBLIN_MCP_SERVERS').pipe(Config.withDefault('[]')),
        CREDENTIAL_KEY: Config.Redacted('GOBLIN_CREDENTIAL_KEY'),
        DODO_PAYMENTS_ENVIRONMENT: billingEnvironment,
        DODO_PAYMENTS_API_KEY: Config.Redacted('DODO_PAYMENTS_API_KEY').pipe(Config.withDefault(Redacted.make(''))),
        DODO_PAYMENTS_WEBHOOK_KEY: Config.Redacted('DODO_PAYMENTS_WEBHOOK_KEY').pipe(
          Config.withDefault(Redacted.make('')),
        ),
        DODO_PRODUCT_ID: Config.Redacted('DODO_PRODUCT_ID').pipe(Config.withDefault(Redacted.make(''))),
        STAGE: runtimeStage(stage.name),
        // The release SHA stage.ts sets: as a prop it changes every release, which forces the rebuild that bakes it
        // into the client bundle (the build's input hash covers files only). Unset (the local stack), crash reports
        // say `dev`.
        ...(build === '' ? {} : { VITE_GOBLIN_BUILD: build }),
      },
    })
    return { url: web.url, authDatabase: db.databaseId }
  }),
)
