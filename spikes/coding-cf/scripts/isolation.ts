import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, Overlay } from '../../coding/scripts/overlay.ts'
import { DockerRunner, docker } from '../../coding/scripts/runner/docker.ts'
import { fixture, request, specification, root, state } from './fixture.ts'

const data = await fixture()
const imageReceipt: { image: string } = await Bun.file(path.join(state, 'image-receipt.json')).json()
const options = {
  image: Bun.argv[2] ?? imageReceipt.image,
  state: path.join(root, '.local/coding-runner/isolation'),
}
const runner = new DockerRunner(options)
await runner.reconcile()
const containers = () => docker(['ps', '-aq', '--filter', `label=goblin.coding.owner=${runner.owner}`])
const id = digest('runner-isolation-20261009')
const overlay = new Overlay(data.base, data.files, id)
for (const [file, content] of data.changes) overlay.edit(file, content, overlay.revision)
const spec = specification(data, id)
const lease = await runner.create(spec)
const rows: Record<string, boolean | string> = {}
try {
  try {
    await runner.create(spec)
    throw new Error('duplicate_lease_accepted')
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'busy') throw error
  }
  rows.duplicateLeaseDenied = true
  const container = await containers()
  if (!container || container.includes('\n')) throw new Error('expected_one_container')
  const script = `const {lookup}=await import('node:dns/promises'); let dns=false,tcp=false;try{await lookup('example.com')}catch{dns=true}try{await Bun.connect({hostname:'1.1.1.1',port:443,socket:{data(){},open(s){s.end()}}})}catch{tcp=true}console.log(JSON.stringify({dns,tcp}));if(!dns||!tcp)process.exitCode=1;`
  const network: { dns: boolean; tcp: boolean } = JSON.parse(
    await docker(['exec', container, 'bun', '-e', script], 15_000),
  )
  if (!network.dns || !network.tcp) throw new Error('network_not_denied')
  rows.dnsDenied = network.dns
  rows.tcpDenied = network.tcp
  const environment: string[] = JSON.parse(await docker(['inspect', container, '--format', '{{json .Config.Env}}']))
  const configured = await readFile(path.join(state, 'runner.env'), 'utf8')
  const token = configured.match(/^GOBLIN_CODING_RUNNER_TOKEN=(\w+)$/mu)?.[1]
  if (
    !token ||
    environment.some(
      (entry) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)/u.test(entry.split('=')[0] ?? '') || entry.includes(token),
    )
  )
    throw new Error('container_environment_not_clean')
  rows.noConfiguredSecret = true
  rows.unprivileged = (await docker(['exec', container, 'id', '-u'])) === '1000'
  const readonly = await docker([
    'inspect',
    container,
    '--format',
    '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}',
  ])
  if (readonly !== 'true none 1000000000 3221225472 256' || !rows.unprivileged)
    throw new Error('resource_limits_not_enforced')
  rows.resourceLimits = true
  if (!(await lease.verify(request(overlay))).passed) throw new Error('fixture_not_green')
  const execution = await lease.execute({
    session: id,
    base: data.base,
    revision: overlay.revision,
    profile: 'cli-hello',
  })
  if (execution.stdout !== 'Hello, world!\n' || execution.exitCode !== 0 || (await containers()).includes('\n'))
    throw new Error('disposable_execution_failed')
  rows.disposableExecution = true
} finally {
  await lease.close()
}
rows.successCleanup = (await containers()) === ''
const malformed = await runner.create(spec)
try {
  await malformed.verify({ ...request(overlay), base: '0'.repeat(40) })
  throw new Error('malformed_accepted')
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'rejected-input') throw error
}
rows.malformedCleanup = (await containers()) === ''
const timeoutSpec = { ...spec, limits: { ...spec.limits } }
const timed = await runner.create(timeoutSpec)
timeoutSpec.limits.verifyTimeoutMs = 1
try {
  await timed.verify(request(overlay))
  throw new Error('timeout_accepted')
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'provider-unavailable') throw error
}
rows.timeoutCleanup = (await containers()) === ''
const previous = await runner.create(spec)
const rebooted = new DockerRunner(options)
await rebooted.reconcile(new Set([id]))
rows.restartPreservesLive = (await containers()) !== ''
const replacement = await rebooted.create(spec)
await previous.close()
rows.obsoleteClosePreservesReplacement = (await containers()) !== ''
await replacement.close()
await runner.create(spec)
await new DockerRunner(options).reconcile()
rows.restartCleanup = (await containers()) === ''
if (Object.values(rows).some((value) => value !== true)) throw new Error('isolation_check_failed')
await writeFile(
  path.join(state, 'isolation.json'),
  JSON.stringify({ base: data.base, imageDigest: runner.imageDigest, ...rows }, null, 2),
  { mode: 0o600 },
)
console.log(JSON.stringify(rows))
