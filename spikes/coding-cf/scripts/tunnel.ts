import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Output from 'alchemy/Output'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Config, Effect, Redacted } from 'effect'

const privateState = path.resolve(import.meta.dirname, '../../../.local/coding-runner')
const names = [
  ['NativeDns', 'coding-native.goblin.surf', 18983],
  ['CloudflareDns', 'coding-cf.goblin.surf', 18984],
  ['DockerDns', 'coding-docker.goblin.surf', 18985],
] as const

export default Alchemy.Stack(
  'goblinCodingRunnerTunnel',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    if ((yield* Alchemy.Stage) !== 'dev') return yield* Effect.die(new Error('coding_tunnel_dev_only'))
    const zoneId = yield* Config.String('GOBLIN_ZONE_ID')
    const tunnel = yield* Cloudflare.Tunnel.Tunnel('CodingTunnel', {
      name: 'goblin-coding-runner-dev',
      ingress: [
        ...names.map(([, hostname, port]) => ({ hostname, service: `http://127.0.0.1:${port}` })),
        { service: 'http_status:404' },
      ],
    })
    for (const [logicalId, hostname] of names)
      yield* Cloudflare.DNS.Record(logicalId, {
        zoneId,
        name: hostname,
        type: 'CNAME',
        content: Output.interpolate`${tunnel.tunnelId}.cfargotunnel.com`,
        proxied: true,
        comment: 'Goblin coding runner dev spike',
      })
    const tokenWritten = Output.mapEffect((token: Redacted.Redacted) =>
      Effect.promise(async () => {
        await mkdir(privateState, { recursive: true, mode: 0o700 })
        const file = path.join(privateState, 'tunnel-token')
        await writeFile(file, Redacted.value(token), { mode: 0o600 })
        await chmod(file, 0o600)
        return true
      }),
    )(tunnel.token)
    return { tunnelId: tunnel.tunnelId, hostnames: names.map(([, hostname]) => hostname), tokenWritten }
  }),
)
