import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import path from 'node:path'
import { chmod, lstat } from 'node:fs/promises'
import { Coding } from './tools.ts'
import { GitHub } from './github.ts'
import { OAuth } from './oauth.ts'
import { SpikeError } from './overlay.ts'
import { RunnerConfig, configured, FallbackRunner } from './runner/config.ts'
import { State } from './state.ts'

const ConfigFile = Schema.Struct({
  repo: Schema.String,
  base: Schema.String,
  root: Schema.String,
  state: Schema.String,
  gh: Schema.String,
  port: Schema.Number,
  origin: Schema.String,
  ownerOrigins: Schema.Array(Schema.String),
  adminKey: Schema.String,
  runner: Schema.optional(RunnerConfig),
  fallback: Schema.optional(RunnerConfig),
})
const configPath = Bun.argv[2] ?? '.local/coding-spike/config.json'
const config = Schema.decodeUnknownSync(ConfigFile)(await Bun.file(configPath).json(), { onExcessProperty: 'error' })
await chmod(configPath, 0o600)
const names = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  await Bun.file(path.join(config.state, 'files.json')).json(),
)
const files = new Map<string, string>()
for (const name of names) {
  if (!/\.(?:ts|tsx|json|jsonc|md|css)$/u.test(name) || name.startsWith('.')) continue
  if (!(await lstat(path.join(config.root, name))).isFile()) continue
  const file = Bun.file(path.join(config.root, name))
  if (file.size <= 100_000) files.set(name, await file.text())
}
const live = new Set(
  new State(path.join(config.state, 'sessions.json')).load(config.base, files).map((overlay) => overlay.id),
)
const runnerOptions = { state: config.state, files, live }
const runnerConfig = config.runner ?? { kind: 'native' as const }
const primary = await configured(runnerConfig, runnerOptions)
const runner = config.fallback ? new FallbackRunner(primary, await configured(config.fallback, runnerOptions)) : primary
const coding = new Coding({
  root: config.root,
  base: config.base,
  files,
  github: new GitHub(config.repo, config.gh),
  state: path.join(config.state, 'sessions.json'),
  runner,
  title: `Coding (${{ native: 'native', docker: 'Docker', cloudflare: 'Cloudflare' }[runnerConfig.kind]})`,
})
const oauth = new OAuth(config.origin, config.ownerOrigins, config.adminKey, path.join(config.state, 'oauth.json'))
await oauth.restore()
let inFlight = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  idleTimeout: 120,
  maxRequestBodySize: 200_000,
  async fetch(request) {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health')
        return Response.json({
          service: 'goblin-coding-spike',
          repo: config.repo,
          base: config.base,
          sessions: coding.sessions.size,
          backend: runnerConfig.kind,
          capacity: { sessions: 4, available: 4 - coding.sessions.size, verifying: coding.checking },
        })
      if (request.method === 'POST' && Number(request.headers.get('content-length') ?? 0) > 200_000)
        return new Response(null, { status: 413 })
      const authResponse = await oauth.handle(request)
      if (authResponse) return authResponse
      if (url.pathname !== '/mcp') return new Response(null, { status: 404 })
      if (!oauth.allowed(request)) return oauth.challenge()
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      if (inFlight >= 4) return new Response(null, { status: 429 })
      inFlight++
      const mcp = coding.server()
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      try {
        await mcp.connect(transport)
        return await transport.handleRequest(request)
      } finally {
        inFlight--
        await mcp.close()
      }
    } catch (error) {
      // expected: the caller gets the spike's error tag (or request_failed) as a 400
      return Response.json({ error: error instanceof SpikeError ? error.message : 'request_failed' }, { status: 400 })
    }
  },
})
console.log(JSON.stringify({ listening: server.url.href, repo: config.repo, base: config.base }))
