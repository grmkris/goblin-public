import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as Schema from 'effect/Schema'

const Config = Schema.Struct({ port: Schema.Number, adminKey: Schema.String })
const backend = Schema.decodeUnknownSync(Schema.Literals(['native', 'docker', 'cloudflare']))(Bun.argv[2])
const directory = path.resolve(import.meta.dirname, '../../../.local/coding-runner')
const configPath = path.join(directory, backend, 'config.json')
const config = Schema.decodeUnknownSync(Config)(await Bun.file(configPath).json())
const response = await fetch(`http://127.0.0.1:${config.port}/operator/approval-code`, {
  method: 'POST',
  headers: { authorization: `Bearer ${config.adminKey}` },
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
})
if (!response.ok) {
  await response.body?.cancel()
  throw new Error(`approval_code_http_${response.status}`)
}
const body = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await response.json())
await mkdir(directory, { recursive: true, mode: 0o700 })
const destination = path.join(directory, `${backend}-prod-approval.txt`)
await writeFile(destination, `${body.code}\n`, { mode: 0o600 })
await chmod(destination, 0o600)
