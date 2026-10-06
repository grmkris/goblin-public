import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Args, UsageError, flagText } from './args.ts'

/** The daily instance; `--origin` or `GOBLIN_ORIGIN` points elsewhere (`http://localhost:18971` locally). */
const DEFAULT_ORIGIN = 'https://dev.goblin.surf'
/** The loopback port the CLI's OAuth client registers its redirect on. */
const DEFAULT_PORT = 18979

export type Settings = {
  readonly origin: string
  readonly endpoint: URL
  readonly scope: string
  readonly redirect: URL
  readonly store: string
  readonly json: boolean
}

const Environment = Config.all({
  origin: Config.String('GOBLIN_ORIGIN').pipe(Config.withDefault(DEFAULT_ORIGIN)),
  configHome: Config.String('XDG_CONFIG_HOME').pipe(Config.withDefault(join(homedir(), '.config'))),
})

/** Flags over environment over defaults. */
export async function settingsOf(args: Args): Promise<Settings> {
  const environment = await Effect.runPromise(Environment)
  const origin = (flagText(args, 'origin') ?? environment.origin).replace(/\/$/u, '')
  if (!URL.canParse(origin)) throw new UsageError(`--origin ${origin} is not a URL`)
  const port = Number(flagText(args, 'port') ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new UsageError('--port takes 1024 to 65535')
  return {
    origin,
    endpoint: new URL('/mcp', origin),
    // Inspection on top of what every /mcp client may do; no identity scopes, which the CLI never reads.
    scope: 'goblin:inspect offline_access',
    redirect: new URL(`http://127.0.0.1:${port}/callback`),
    store: join(environment.configHome, 'goblin', 'credentials.json'),
    json: args.flags.get('json') === true,
  }
}
