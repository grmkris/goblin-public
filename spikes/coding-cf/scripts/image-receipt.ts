import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Config, Effect, Redacted, Schema } from 'effect'
import { root, state } from './fixture.ts'

const deployed = Schema.decodeUnknownSync(
  Schema.Struct({
    attr: Schema.Struct({
      configuration: Schema.Struct({ image: Schema.String }),
      hash: Schema.Struct({ digest: Schema.String }),
    }),
  }),
)(await Bun.file(path.join(root, '.alchemy/state/goblinCodingCfSpike/dev/VerifierContainer.json')).json()).attr
if (!/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[\w-]+@sha256:[a-f0-9]{64}$/u.test(deployed.configuration.image))
  throw new Error('invalid_deployed_image')
const token = await Effect.runPromise(Config.Redacted('CLOUDFLARE_API_TOKEN'))
const account = await Effect.runPromise(Config.String('CLOUDFLARE_ACCOUNT_ID'))
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${Redacted.value(token)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: ['pull'], expiration_minutes: 30 }),
  },
)
if (!response.ok) {
  await response.body?.cancel()
  throw new Error(`registry_credentials_http_${response.status}`)
}
const credentials = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      username: Schema.optional(Schema.String),
      user: Schema.optional(Schema.String),
      password: Schema.String,
    }),
  }),
)(await response.json()).result
const username = credentials.username ?? credentials.user
if (!username) throw new Error('registry_username_missing')
const config = path.join(root, '.local/coding-runner/registry')
await mkdir(config, { recursive: true, mode: 0o700 })
const login = Bun.spawn(
  ['docker', '--config', config, 'login', 'registry.cloudflare.com', '--username', username, '--password-stdin'],
  {
    stdin: new Blob([credentials.password]),
    stdout: 'ignore',
    stderr: 'ignore',
  },
)
if ((await login.exited) !== 0) throw new Error('registry_login_failed')
await chmod(path.join(config, 'config.json'), 0o600)
const pull = Bun.spawn(['docker', '--config', config, 'pull', deployed.configuration.image], {
  stdout: 'ignore',
  stderr: 'ignore',
})
if ((await pull.exited) !== 0) throw new Error('image_pull_failed')
await writeFile(
  path.join(state, 'image-receipt.json'),
  JSON.stringify({ image: deployed.configuration.image, imageDigest: deployed.hash.digest }, null, 2),
  { mode: 0o600 },
)
console.log(JSON.stringify({ imageDigest: deployed.hash.digest, pulled: true }))
