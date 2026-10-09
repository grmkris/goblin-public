import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Config, Effect, Schema } from 'effect'
import { Overlay, SpikeError } from '../../coding/scripts/overlay.ts'
import { Verifier } from '../../coding/scripts/verifier.ts'
import { compilers } from '../../coding/scripts/binaries.ts'
import { boundedJson, boundedText, decodeRunnerInput } from '../../coding/scripts/wire.ts'

const socket = await Effect.runPromise(Config.String('RUNNER_SOCKET').pipe(Config.withDefault('')))
const root = '/repo'
const base = (await readFile('/fixture/base', 'utf8')).trim()
const names = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  JSON.parse(await readFile('/fixture/files.json', 'utf8')),
)
const files = new Map<string, string>()
for (const name of names) {
  if (!/^apps\/cli\/(?:src|test)\/.*\.ts$/u.test(name)) continue
  files.set(name, await readFile(path.join(root, name), 'utf8'))
}
await mkdir('/state', { recursive: true })
const binaries = compilers('/state')
let session: { overlay: Overlay; verifier: Verifier } | undefined
let busy = false

const receive = async (request: Request): Promise<Overlay> => {
  const input = decodeRunnerInput(await boundedJson(request))
  if (input.base !== base) throw new SpikeError('snapshot_mismatch')
  if (session && session.overlay.id !== input.session) throw new SpikeError('session_mismatch')
  const next = new Overlay(base, files, input.session)
  for (const [file, content] of input.changes) next.edit(file, content, next.revision)
  if (next.revision !== input.revision) throw new SpikeError('revision_mismatch')
  return next
}

const ready = async (next: Overlay) => {
  session ??= { overlay: next, verifier: new Verifier(root, next, binaries.effect, binaries.type) }
  if (session.overlay !== next) {
    session.overlay.changes.clear()
    for (const [file, content] of next.changes) session.overlay.changes.set(file, content)
  }
  return session.verifier.ready()
}

/** Fixed execution happens in a separate container, destroyed by the Worker after this response. */
const execute = async (overlay: Overlay) => {
  await mkdir('/execution', { recursive: true })
  for (const name of await readdir('/execution'))
    await rm(path.join('/execution', name), { recursive: true, force: true })
  const copy = Bun.spawn(
    ['tar', '-cf', '/execution/base.tar', '--exclude=node_modules', '--exclude=*/node_modules', '.'],
    {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    },
  )
  if ((await copy.exited) !== 0) throw new SpikeError('execution_copy_failed')
  const extract = Bun.spawnSync(['tar', '-xf', '/execution/base.tar', '-C', '/execution'])
  if (extract.exitCode !== 0) throw new SpikeError('execution_copy_failed')
  const link = Bun.spawnSync(['ln', '-s', '/repo/node_modules', '/execution/node_modules'])
  if (link.exitCode !== 0) throw new SpikeError('execution_dependencies_failed')
  await symlink('/repo/apps/cli/node_modules', '/execution/apps/cli/node_modules')
  for (const [file, content] of overlay.changes) {
    const target = path.join('/execution', file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const child = Bun.spawn(['bun', 'apps/cli/src/main.ts', 'hello'], {
    cwd: '/execution',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedText(new Response(child.stdout), 10_000),
      boundedText(new Response(child.stderr), 10_000),
      child.exited,
    ])
    return { revision: overlay.revision, exitCode, stdout, stderr }
  } catch (error) {
    child.kill('SIGKILL')
    await child.exited
    throw error
  }
}

const handler = async (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname
  if (pathname === '/health')
    return Response.json({
      ready: true,
      base,
      backend: socket ? 'docker' : 'cloudflare',
      capacity: { maxSessions: 1, busy },
    })
  if (request.method !== 'POST' || !['/verify', '/execute', '/close'].includes(pathname))
    return new Response(null, { status: 404 })
  if (pathname === '/close') {
    await session?.verifier.close()
    session = undefined
    return Response.json({ closed: true })
  }
  if (busy) return Response.json({ error: 'verifier_busy' }, { status: 429 })
  busy = true
  try {
    const next = await receive(request)
    return Response.json(pathname === '/verify' ? await ready(next) : await execute(next))
  } catch (error) {
    // expected: the caller gets the spike's error tag (or runner_failed) as a 400, and the session starts over
    await session?.verifier.close()
    session = undefined
    return Response.json({ error: error instanceof SpikeError ? error.message : 'runner_failed' }, { status: 400 })
  } finally {
    busy = false
  }
}

Bun.serve({ port: 8787, idleTimeout: 120, maxRequestBodySize: 500_000, fetch: handler })
if (socket) Bun.serve({ unix: socket, fetch: handler })
