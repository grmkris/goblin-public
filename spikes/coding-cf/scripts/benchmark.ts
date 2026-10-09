import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, Overlay } from '../../coding/scripts/overlay.ts'
import { type CodingRunnerFactory } from '../../coding/scripts/runner/contract.ts'
import { sampleStats } from './stats.ts'
import { backends, fixture, request, specification, state } from './fixture.ts'

const data = await fixture()
const results: Record<string, Sample[]> = {}
const stats: Record<string, Awaited<ReturnType<ReturnType<typeof sampleStats>['stop']>>> = {}
const save = () =>
  writeFile(path.join(state, 'benchmark-three.json'), JSON.stringify({ base: data.base, results, stats }, null, 2), {
    mode: 0o600,
  })
const runners = await backends(
  data,
  Bun.argv[2],
  Bun.argv[3] ?? 'https://goblin-coding-cf-dev.kristjan-grm11775.workers.dev',
)
type Sample = { temperature: string; startupMs: number; verifyMs: number; executeMs?: number; cleanupMs: number }
const milliseconds = (start: number) => Math.round(performance.now() - start)
const percentile = (numbers: number[], fraction: number) =>
  numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1] ?? null
function overlayFor(backend: string, temperature: string, i: number): Overlay {
  const overlay = new Overlay(data.base, data.files, digest(`runner-bench-${backend}-${temperature}-${i}-${data.base}`))
  for (const [file, content] of data.changes) overlay.edit(file, content, overlay.revision)
  return overlay
}
async function coldSample(backend: string, factory: CodingRunnerFactory, i: number): Promise<Sample> {
  const overlay = overlayFor(backend, 'cold', i)
  const id = overlay.id
  const start = performance.now()
  const lease = await factory.create(specification(data, id))
  const startupMs = milliseconds(start)
  let row: Sample | undefined
  try {
    const checking = performance.now()
    if (!(await lease.verify(request(overlay))).passed) throw new Error('benchmark_code_failure')
    const verifyMs = milliseconds(checking)
    const executing = performance.now()
    {
      const receipt = await lease.execute({
        session: id,
        base: data.base,
        revision: overlay.revision,
        profile: 'cli-hello',
      })
      if (receipt.exitCode !== 0 || receipt.stdout !== 'Hello, world!\n') throw new Error('benchmark_execution_failure')
    }
    row = {
      temperature: 'cold',
      startupMs,
      verifyMs,
      executeMs: milliseconds(executing),
      cleanupMs: 0,
    }
  } finally {
    const closing = performance.now()
    await lease.close()
    if (row) {
      row.cleanupMs = milliseconds(closing)
    }
  }
  if (!row) throw new Error('missing_benchmark_sample')
  return row
}
async function measure(backend: string, factory: CodingRunnerFactory): Promise<Sample[]> {
  const samples: Sample[] = []
  results[backend] = samples
  for (let i = 0; i < 20; i++) {
    samples.push(await coldSample(backend, factory, i))
    await save()
    console.log(JSON.stringify({ backend, cold: i + 1 }))
  }
  const id = digest(`runner-bench-${backend}-warm-${data.base}`)
  const overlay = new Overlay(data.base, data.files, id)
  for (const [file, content] of data.changes) overlay.edit(file, content, overlay.revision)
  const lease = await factory.create(specification(data, id))
  try {
    if (!(await lease.verify(request(overlay))).passed) throw new Error('benchmark_warmup_failure')
    for (let i = 0; i < 20; i++) {
      const start = performance.now()
      if (!(await lease.verify(request(overlay))).passed) throw new Error('benchmark_code_failure')
      samples.push({ temperature: 'warm', startupMs: 0, verifyMs: milliseconds(start), cleanupMs: 0 })
      await save()
      console.log(JSON.stringify({ backend, warm: i + 1 }))
    }
  } finally {
    await lease.close()
  }
  return samples
}
for (const [backend, factory] of Object.entries(runners)) {
  const sampler = sampleStats(runners.docker.owner)
  try {
    results[backend] = await measure(backend, factory)
  } finally {
    stats[backend] = await sampler.stop()
    await save()
  }
  for (const temperature of ['cold', 'warm']) {
    const rows = results[backend]?.filter((row) => row.temperature === temperature) ?? []
    console.log(
      JSON.stringify({
        backend,
        temperature,
        n: rows.length,
        p50: percentile(
          rows.map((row) => row.verifyMs),
          0.5,
        ),
        p95: percentile(
          rows.map((row) => row.verifyMs),
          0.95,
        ),
      }),
    )
  }
}
