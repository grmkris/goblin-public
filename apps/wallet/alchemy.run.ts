import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { fileURLToPath } from 'node:url'
import { resolveStage } from '../../scripts/stage-config.ts'

/** Paths the Worker answers before any static asset (the SPA fallback never swallows them). */
const WORKER_FIRST = ['/mcp', '/mcp/*', '/api/*', '/oauth/*', '/.well-known/*', '/health', '/views/*']

export default Alchemy.Stack(
  'goblin-wallet',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = resolveStage(yield* Alchemy.Stage, 'goblin-wallet')
    // Empty domain: the Worker serves on workers.dev only.
    const domain = yield* Config.String('WALLET_DOMAIN').pipe(Config.withDefault(''))
    const zoneId = domain === '' ? '' : yield* Config.String('WALLET_ZONE_ID')
    const wallet = yield* Cloudflare.Worker('Wallet', {
      name: stage.workerName,
      main: fileURLToPath(new URL('./src/worker.ts', import.meta.url)),
      workersDev: true,
      ...(domain === '' ? {} : { domain: { name: domain, zoneId } }),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      observability: stage.observability,
      assets: {
        directory: fileURLToPath(new URL('../wallet-web/dist', import.meta.url)),
        config: { notFoundHandling: 'single-page-application', runWorkerFirst: WORKER_FIRST },
      },
      env: {
        LEDGER: Cloudflare.DurableObject('WalletLedger', { className: 'WalletLedger' }),
        AUTH: Cloudflare.DurableObject('WalletAuth', { className: 'WalletAuth' }),
        RELAY: Cloudflare.DurableObject('WalletRelay', { className: 'WalletRelay' }),
        PRIVY_APP_ID: Config.String('PRIVY_APP_ID'),
        PRIVY_SIGNER_ID: Config.String('PRIVY_SIGNER_ID').pipe(Config.withDefault('')),
        PRIVY_POLICY_ID: Config.String('PRIVY_POLICY_ID').pipe(Config.withDefault('')),
        PRIVY_APP_SECRET: Config.Redacted('PRIVY_APP_SECRET'),
        PRIVY_AUTHORIZATION_KEY: Config.Redacted('PRIVY_AUTHORIZATION_KEY'),
        RELAY_PRIVATE_KEY: Config.Redacted('RELAY_PRIVATE_KEY'),
        RPC_URLS: Config.String('WALLET_RPC_URLS').pipe(Config.withDefault('')),
        WALLET_LIVE: Config.String('WALLET_LIVE').pipe(Config.withDefault('0')),
      },
    })
    return { url: wallet.url }
  }),
)
