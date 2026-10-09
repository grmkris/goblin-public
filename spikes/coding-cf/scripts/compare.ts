import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, Overlay } from '../../coding/scripts/overlay.ts'
import { type CheckReceipt, type CodingRunnerLease } from '../../coding/scripts/runner/contract.ts'
import { backends, fixture, request, specification, state } from './fixture.ts'

const data = await fixture()
const runners = await backends(
  data,
  Bun.argv[2],
  Bun.argv[3] ?? 'https://goblin-coding-cf-dev.kristjan-grm11775.workers.dev',
)
const id = digest(`goblin-runner-parity-20261009:${data.base}`)
const overlay = new Overlay(data.base, data.files, id)
const leases: CodingRunnerLease[] = []
const rows: unknown[] = []
const normalize = (receipt: CheckReceipt) =>
  JSON.stringify([...receipt.diagnostics].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
let cleanupFailed = false
try {
  for (const runner of Object.values(runners)) leases.push(await runner.create(specification(data, id)))
  for (const step of ['invalid', 'hello', 'warm-1', 'warm-2']) {
    overlay.changes.clear()
    if (step === 'invalid')
      overlay.edit('apps/cli/src/cf-spike-probe.ts', 'export const codingProbe: string = 123\n', overlay.revision)
    else for (const [file, content] of data.changes) overlay.edit(file, content, overlay.revision)
    const receipts: CheckReceipt[] = []
    for (const lease of leases) receipts.push(await lease.verify(request(overlay)))
    const first = receipts[0]
    if (!first) throw new Error('missing_receipt')
    for (const receipt of receipts) {
      if (
        receipt.revision !== first.revision ||
        receipt.passed !== first.passed ||
        normalize(receipt) !== normalize(first)
      )
        throw new Error(`different_results:${step}`)
      if (receipt.passed !== (step !== 'invalid') || receipt.diagnostics.length !== (step === 'invalid' ? 2 : 0))
        throw new Error(`unexpected_result:${step}`)
    }
    const row = {
      step,
      revision: overlay.revision,
      passed: first.passed,
      diagnostics: first.diagnostics.length,
      backends: receipts.map(({ backend, imageDigest, elapsedMs }) => ({ backend, imageDigest, elapsedMs })),
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  const executions = []
  for (const lease of leases) {
    const receipt = await lease.execute({
      session: id,
      base: data.base,
      revision: overlay.revision,
      profile: 'cli-hello',
    })
    if (receipt.exitCode !== 0 || receipt.stdout !== 'Hello, world!\n' || receipt.stderr !== '')
      throw new Error('hello_execution_failed')
    executions.push(receipt)
  }
  await writeFile(
    path.join(state, 'comparison-three.json'),
    JSON.stringify({ base: data.base, rows, executions }, null, 2),
    { mode: 0o600 },
  )
} finally {
  const closed = await Promise.allSettled(leases.map((lease) => lease.close()))
  cleanupFailed = closed.some((result) => result.status === 'rejected')
}

if (cleanupFailed) throw new Error('runner_cleanup_failed')
