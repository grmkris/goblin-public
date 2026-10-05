import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { fileURLToPath } from 'node:url'
import { resolveStage } from '../../scripts/stage-config.ts'

const root = fileURLToPath(new URL('./', import.meta.url))
const runtimeStage = (name: string) => (name === 'local' || name === 'dev' || name === 'prod' ? name : 'test')

export default Alchemy.Stack(
  'Purrable',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = resolveStage(yield* Alchemy.Stage)
    const appUrl = yield* Config.String('PURRABLE_APP_URL').pipe(Config.withDefault('http://localhost:18971'))
    const domain = yield* Config.String('PURRABLE_DOMAIN').pipe(Config.withDefault(''))
    const signupMode = yield* Config.String('PURRABLE_SIGNUP_MODE').pipe(Config.withDefault('closed'))
    // An address on an apex onboarded for Cloudflare Email Sending; empty means no mail and no email verification.
    const mailSender = yield* Config.String('PURRABLE_MAIL_SENDER').pipe(Config.withDefault(''))
    if (signupMode === 'open' && mailSender === '' && !stage.local)
      return yield* Effect.die(
        new Error('open sign-up on a deployed stage needs PURRABLE_MAIL_SENDER (email verification)'),
      )
    if (stage.name === 'dev' && signupMode === 'open')
      return yield* Effect.die(new Error('dev_sign_up_must_be_closed_or_invite_only'))
    const billingEnvironment = yield* Config.String('DODO_PAYMENTS_ENVIRONMENT').pipe(
      Config.withDefault(stage.name === 'prod' ? 'live_mode' : 'test_mode'),
    )
    if ((stage.name === 'prod') !== (billingEnvironment === 'live_mode'))
      return yield* Effect.die(new Error('Dodo stage and billing mode must match'))
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
      crons: ['17 * * * *'],
      ...(domain === ''
        ? {}
        : {
            domain: {
              name: domain,
              zoneId: '8335636aef2c6209a4327d7a282b31d2',
              ...(stage.name === 'prod' ? { aliases: [`www.${domain}`] } : {}),
            },
          }),
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
        SIGNUP_MODE: signupMode,
        ...(mailSender === ''
          ? {}
          : {
              MAIL: Cloudflare.Email.SendEmail('Mail', { allowedSenderAddresses: [mailSender] }),
              MAIL_SENDER: mailSender,
            }),
        SIGNUP_INVITE_CODE: Config.Redacted('PURRABLE_SIGNUP_INVITE_CODE').pipe(Config.withDefault(Redacted.make(''))),
        MODEL_BASE_URL: Config.String('PURRABLE_MODEL_BASE_URL').pipe(Config.withDefault('http://127.0.0.1:8317/v1')),
        MODEL_ID: Config.String('PURRABLE_MODEL_ID').pipe(Config.withDefault('gemini-3.8-flash')),
        MODELS: Config.String('PURRABLE_MODELS').pipe(Config.withDefault('')),
        MODEL_KEY: Config.Redacted('PURRABLE_MODEL_KEY').pipe(Config.withDefault(Redacted.make(''))),
        MODEL_DAILY_TOKENS: Config.String('PURRABLE_MODEL_DAILY_TOKENS').pipe(Config.withDefault('300000')),
        MODEL_TOKEN_WEIGHTS: Config.String('PURRABLE_MODEL_TOKEN_WEIGHTS').pipe(Config.withDefault('{}')),
        MEMORY_MODEL: Config.String('PURRABLE_MEMORY_MODEL').pipe(Config.withDefault('')),
        MCP_SERVERS: Config.String('PURRABLE_MCP_SERVERS').pipe(Config.withDefault('[]')),
        CREDENTIAL_KEY: Config.Redacted('PURRABLE_CREDENTIAL_KEY'),
        DODO_PAYMENTS_ENVIRONMENT: billingEnvironment,
        DODO_PAYMENTS_API_KEY: Config.Redacted('DODO_PAYMENTS_API_KEY').pipe(Config.withDefault(Redacted.make(''))),
        DODO_PAYMENTS_WEBHOOK_KEY: Config.Redacted('DODO_PAYMENTS_WEBHOOK_KEY').pipe(
          Config.withDefault(Redacted.make('')),
        ),
        DODO_PRODUCT_ID: Config.Redacted('DODO_PRODUCT_ID').pipe(Config.withDefault(Redacted.make(''))),
        STAGE: runtimeStage(stage.name),
      },
    })
    return { url: web.url, authDatabase: db.databaseId }
  }),
)
