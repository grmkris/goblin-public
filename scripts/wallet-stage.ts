/** Goblin Wallet's stage loader: `dev` (local), `plan:dev` and `deploy:dev`. scripts/stage.ts stays goblin's own. */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveStage } from './stage-config.ts'
import { attachStageState, DEFAULT_RELEASE_ROOT } from './stage-state.ts'

const root = resolve(import.meta.dirname, '..')
const releaseRoot = process.env['GOBLIN_RELEASE_ROOT'] ?? DEFAULT_RELEASE_ROOT
const command = Bun.argv[2] ?? 'dev'
const subcommands: Record<string, string> = { dev: 'dev', 'plan:dev': 'plan', 'deploy:dev': 'deploy' }
const alchemyCommand = subcommands[command]
if (alchemyCommand === undefined) throw new Error('unsupported_wallet_stage_command')

const stage = resolveStage(command === 'dev' ? 'local' : 'dev', 'goblin-wallet')
const config = resolve(process.env['GOBLIN_ENV_DIR'] ?? resolve(root, '.local'), 'wallet-dev.env')
const shared = process.env['GOBLIN_CLOUD_ENV_FILE'] ?? resolve(root, '.local/cloud.env')
const requirePrivate = (file: string) => {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`private_stage_file_requires_mode_600: ${file}`)
}

// One wallet deploy at a time, beside goblin's own deploy lock.
if (!stage.local && process.env['GOBLIN_STAGE_LOCK_HELD'] !== `wallet:${releaseRoot}`) {
  const locked = Bun.spawn(
    ['flock', '-x', resolve(releaseRoot, 'wallet-deploy.lock'), 'bun', import.meta.filename, ...Bun.argv.slice(2)],
    {
      cwd: root,
      env: { ...process.env, GOBLIN_STAGE_LOCK_HELD: `wallet:${releaseRoot}` },
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  )
  process.exit(await locked.exited)
}
if (!stage.local) {
  process.umask(0o007)
  // The first deploy seeds the wallet's state directory; goblin's stages are seeded by hand.
  mkdirSync(resolve(releaseRoot, 'alchemy/state/goblin-wallet', stage.name), { recursive: true })
  attachStageState(root, stage.name, releaseRoot, { stack: 'goblin-wallet', dir: 'apps/wallet' })
}

const childEnv: Record<string, string | undefined> = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (/^(CLOUDFLARE_|GOBLIN_|PRIVY_|RELAY_|TREASURY_|WALLET_|ALCHEMY_STAGE)/u.test(key)) delete childEnv[key]
}
childEnv['GOBLIN_STAGE'] = stage.name
childEnv['GOBLIN_RELEASE_ROOT'] = releaseRoot
childEnv['BUN_CONFIG_NO_ENVFILE'] = '1'

requirePrivate(config)
const envFiles = [config]
if (stage.local) {
  childEnv['CLOUDFLARE_ACCOUNT_ID'] = '0'.repeat(32)
  childEnv['CLOUDFLARE_API_TOKEN'] = 'local-placeholder-token'
} else {
  requirePrivate(shared)
  // Cloudflare credentials first, then the wallet's own values, merged into one temporary file.
  const merged = `/tmp/goblin-wallet-${stage.name}-${process.pid}.env`
  writeFileSync(merged, `${readFileSync(shared, 'utf8')}\n${readFileSync(config, 'utf8')}`, { mode: 0o600 })
  process.on('exit', () => {
    if (existsSync(merged)) unlinkSync(merged)
  })
  envFiles.splice(0, envFiles.length, merged)
}

// The Worker serves the SPA build as static assets, so the build comes first.
const build = Bun.spawn(['bun', 'run', 'build'], {
  cwd: resolve(root, 'apps/wallet-web'),
  stdio: ['ignore', 'inherit', 'inherit'],
})
if ((await build.exited) !== 0) throw new Error('wallet_web_build_failed')

const args = [
  resolve(root, 'node_modules/alchemy/bin/alchemy.js'),
  alchemyCommand,
  '--config',
  resolve(root, 'apps/wallet/alchemy.run.ts'),
  '--stage',
  stage.name,
  ...envFiles.flatMap((file) => ['--env-file', file]),
]
if (command === 'deploy:dev') args.push('--yes')
const child = Bun.spawn(['bun', ...args], {
  cwd: resolve(root, 'apps/wallet'),
  env: childEnv,
  stdio: [command === 'dev' || command === 'deploy:dev' ? 'inherit' : 'ignore', 'inherit', 'inherit'],
})
process.exitCode = await child.exited
