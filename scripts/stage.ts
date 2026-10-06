/** One stage loader; shared Cloudflare credentials stay in the existing mode-600 dev configuration. */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveStage } from './stage-config.ts'

const root = resolve(import.meta.dirname, '..')
const command = Bun.argv[2] ?? 'dev'
if (!['dev', 'deploy:dev', 'plan:dev', 'destroy:dev', 'deploy:prod', 'plan:prod', 'smoke:prod'].includes(command))
  throw new Error('unsupported_stage_command')
// Destroying dev deletes the owner account, the agent's conversations and every stored MCP credential.
if (command === 'destroy:dev' && !Bun.argv.includes('--confirm-reset'))
  throw new Error('destroy_dev_requires_--confirm-reset: it erases the owner account, conversations and credentials')
const stage = resolveStage(command === 'dev' ? 'local' : command.endsWith(':prod') ? 'prod' : 'dev')
if (stage.name === 'prod' && process.env['GOBLIN_CONFIRM_PROD'] !== '1')
  throw new Error('prod_requires_GOBLIN_CONFIRM_PROD=1')
const config = resolve(root, '.local', `${stage.name}.env`)
const shared = resolve(root, '.local/cloud.env')
const childEnv: Record<string, string | undefined> = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (/^(CLOUDFLARE_|GOBLIN_|DODO_|MYAGENT_|MYBROWSER_|MYPLAN_|MYINBOX_|MYTMUX_|LITELLM_|ALCHEMY_STAGE)/u.test(key))
    delete childEnv[key]
}
childEnv['GOBLIN_STAGE'] = stage.name
childEnv['BUN_CONFIG_NO_ENVFILE'] = '1'
if (command === 'smoke:prod') {
  if ((statSync(config).mode & 0o077) !== 0) throw new Error('private_stage_file_requires_mode_600')
  const smoke = Bun.spawn(['bun', '--env-file', config, resolve(root, 'scripts/smoke-dev.ts')], {
    cwd: root,
    env: childEnv,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await smoke.exited)
}
const args = [
  resolve(root, 'node_modules/alchemy/bin/alchemy.js'),
  {
    dev: 'dev',
    'plan:dev': 'plan',
    'deploy:dev': 'deploy',
    'destroy:dev': 'destroy',
    'deploy:prod': 'deploy',
    'plan:prod': 'plan',
  }[command] ?? 'dev',
  '--config',
  resolve(root, 'apps/web/alchemy.run.ts'),
  '--stage',
  stage.name,
]
const addEnvFile = (file: string) => {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`private_stage_file_requires_mode_600: ${file}`)
  args.push('--env-file', file)
}
if (stage.local) {
  childEnv['CLOUDFLARE_ACCOUNT_ID'] = '0'.repeat(32)
  childEnv['CLOUDFLARE_API_TOKEN'] = 'local-placeholder-token'
  childEnv['GOBLIN_APP_URL'] = 'http://localhost:18971'
  childEnv['GOBLIN_BETTER_AUTH_SECRET'] = 'goblin-local-only-secret-not-for-cloudflare-00000000000000000'
  childEnv['GOBLIN_MODEL_KEY'] = process.env['CLIPROXY_API_KEY'] ?? ''
  // Local-only defaults; .local/local.env values override them.
  childEnv['GOBLIN_CREDENTIAL_KEY'] = 'Z29ibGluLWxvY2FsLW9ubHkta2V5ISEhISEhISEhISE='
  childEnv['GOBLIN_SIGNUP_MODE'] = 'open'
  childEnv['GOBLIN_MAIL_SENDER'] = 'hello@goblin.test'
  if (existsSync(config)) addEnvFile(config)
} else {
  addEnvFile(shared)
  addEnvFile(config)
}
if (!stage.local) {
  const merged = `/tmp/goblin-${stage.name}-${process.pid}.env`
  writeFileSync(merged, `${readFileSync(shared, 'utf8')}\n${readFileSync(config, 'utf8')}`, { mode: 0o600 })
  for (let index = args.length - 2; index >= 0; index--) if (args[index] === '--env-file') args.splice(index, 2)
  args.push('--env-file', merged)
  process.on('exit', () => {
    if (existsSync(merged)) unlinkSync(merged)
  })
}
if (command === 'deploy:dev' || command === 'deploy:prod' || command === 'destroy:dev') args.push('--yes')
// The agent app toolchain (packages/app/dist) is bundled into the Worker, so it is built first (ADR 0021).
const toolchain = Bun.spawn(['bun', 'run', 'build'], {
  cwd: resolve(root, 'packages/app'),
  stdio: ['ignore', 'inherit', 'inherit'],
})
if ((await toolchain.exited) !== 0) throw new Error('agent_app_toolchain_build_failed')
const child = Bun.spawn(['bun', ...args], {
  cwd: resolve(root, 'apps/web'),
  env: childEnv,
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exitCode = await child.exited
