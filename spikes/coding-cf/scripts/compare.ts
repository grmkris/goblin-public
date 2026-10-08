import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, Overlay } from '../../coding/scripts/overlay.ts'
import { Verifier } from '../../coding/scripts/verifier.ts'
import { compilers } from '../../coding/scripts/binaries.ts'
import { boundedJson, decodeRunnerResult } from '../../coding/scripts/wire.ts'

const root = path.resolve(import.meta.dirname, '../../..')
const state = path.join(root, '.local/coding-cf-spike')
const config: { root: string; base: string } = JSON.parse(
  await readFile(path.join(root, '.local/coding-spike/config.json'), 'utf8'),
)
const names: string[] = JSON.parse(await readFile(path.join(root, '.local/coding-spike/files.json'), 'utf8'))
const files = new Map<string, string>()
for (const name of names) {
  if (/^apps\/cli\/(?:src|test)\/.*\.ts$/u.test(name))
    files.set(name, await readFile(path.join(config.root, name), 'utf8'))
}
const published = path.join(root, '.local/coding-spike/pr')
const changes: [string, string][] = []
for (const [file, content] of files) {
  const candidate = Bun.file(path.join(published, file))
  if (await candidate.exists()) {
    const changed = await candidate.text()
    if (changed !== content) changes.push([file, changed])
  }
}
for await (const file of new Bun.Glob('apps/cli/{src,test}/**/*.ts').scan(published)) {
  if (!files.has(file)) changes.push([file, await Bun.file(path.join(published, file)).text()])
}
if (changes.length === 0 || changes.length > 8) throw new Error('missing_hello_fixture')
const id = digest('goblin-cf-comparison-hello-20261008')
const overlay = new Overlay(config.base, files, id)
const binaries = compilers(state)
const native = new Verifier(config.root, overlay, binaries.effect, binaries.type)
const target = Bun.argv[2] ?? 'docker'
const env = await readFile(path.join(state, 'runner.env'), 'utf8')
const token = env.match(/^GOBLIN_CODING_RUNNER_TOKEN=(\w+)$/mu)?.[1]
if (!token) throw new Error('runner_token_missing')

const payload = () => ({ base: config.base, session: id, revision: overlay.revision, changes: [...overlay.changes] })
const request = async (operation: 'verify' | 'execute' | 'close'): Promise<unknown> => {
  if (target === 'docker') {
    if (operation === 'close') return { closed: true }
    const script = `const body=await Bun.stdin.text(); const r=await fetch('http://127.0.0.1:8787/${operation}',{method:'POST',headers:{'content-type':'application/json'},body}); console.log(await r.text()); if(!r.ok) process.exitCode=1;`
    const child = Bun.spawn(['docker', 'exec', '-i', 'goblin-coding-cf-local', 'bun', '-e', script], {
      stdin: new Blob([JSON.stringify(payload())]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    if ((await child.exited) !== 0)
      throw new Error(`local_runner_failed:${output.slice(0, 300)}:${error.slice(0, 300)}`)
    return JSON.parse(output)
  }
  const url = new URL(`/${operation}`, target)
  url.searchParams.set('job', id)
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload()),
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`remote_runner_failed:${response.status}`)
  }
  return boundedJson(response)
}

const rows: unknown[] = []
let cleanupFailed = false
try {
  for (const step of ['invalid', 'hello', 'warm-1', 'warm-2']) {
    overlay.changes.clear()
    if (step === 'invalid')
      overlay.edit('apps/cli/src/cf-spike-probe.ts', 'export const codingProbe: string = 123\n', overlay.revision)
    else for (const [file, content] of changes) overlay.edit(file, content, overlay.revision)
    const local = await native.ready()
    const start = performance.now()
    const remote = decodeRunnerResult(await request('verify'))
    const wallMs = Math.round(performance.now() - start)
    if (
      remote.revision !== local.revision ||
      remote.passed !== local.passed ||
      JSON.stringify(remote.diagnostics) !== JSON.stringify(local.diagnostics)
    )
      throw new Error(`different_results:${step}`)
    const expectedPass = step !== 'invalid'
    if (local.passed !== expectedPass || local.diagnostics.length !== (expectedPass ? 0 : 2))
      throw new Error(`unexpected_result:${step}`)
    const row = {
      step,
      passed: local.passed,
      revision: local.revision,
      diagnostics: local.diagnostics.length,
      netcupMs: local.elapsedMs,
      runnerMs: remote.elapsedMs,
      runnerWallMs: wallMs,
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  const execution = await request('execute')
  if (
    typeof execution !== 'object' ||
    execution === null ||
    !('revision' in execution) ||
    execution.revision !== overlay.revision ||
    !('exitCode' in execution) ||
    execution.exitCode !== 0 ||
    !('stdout' in execution) ||
    execution.stdout !== 'Hello, world!\n'
  )
    throw new Error(`hello_execution_failed:${JSON.stringify(execution).slice(0, 500)}`)
  console.log(JSON.stringify({ execution }))
  const receipt = { target, base: config.base, changedFiles: changes.map(([file]) => file), rows, execution }
  await mkdir(state, { recursive: true })
  await writeFile(
    path.join(state, target === 'docker' ? 'comparison-local.json' : 'comparison-cloudflare.json'),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  )
} finally {
  const cleanup = await Promise.allSettled([native.close(), request('close')])
  cleanupFailed = cleanup.some((result) => result.status === 'rejected')
  if (cleanupFailed) console.error('runner_cleanup_failed')
}
if (cleanupFailed) throw new Error('runner_cleanup_failed')
