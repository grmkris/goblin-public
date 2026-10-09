import { docker } from '../../coding/scripts/runner/docker.ts'

function memoryBytes(value: string): number {
  const match = /^([\d.]+)(B|KiB|MiB|GiB)$/u.exec(value)
  if (!match) return 0
  const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }
  return Number(match[1]) * (units[match[2] ?? ''] ?? 0)
}
/** Sampled Docker peaks are lower bounds, not provider metrics or kernel high-water marks. */
export function sampleStats(owner: string) {
  let stopped = false
  const peaks = { samples: 0, cpuPercent: 0, memoryBytes: 0, pids: 0 }
  const work = (async () => {
    for (;;) {
      if (stopped) break
      try {
        const ids = (await docker(['ps', '-q', '--filter', `label=goblin.coding.owner=${owner}`]))
          .split('\n')
          .filter(Boolean)
        if (ids.length) {
          const rows = await docker([
            'stats',
            '--no-stream',
            '--format',
            '{{.CPUPerc}} {{.MemUsage}} {{.PIDs}}',
            ...ids,
          ])
          for (const row of rows.split('\n')) {
            const [cpu, memory, , , pids] = row.split(' ')
            peaks.samples++
            peaks.cpuPercent = Math.max(peaks.cpuPercent, Number(cpu?.replace('%', '')) || 0)
            peaks.memoryBytes = Math.max(peaks.memoryBytes, memoryBytes(memory ?? ''))
            peaks.pids = Math.max(peaks.pids, Number(pids) || 0)
          }
        }
      } catch {
        /* A disposable container can vanish between ps and stats. */
      }
      await Bun.sleep(500)
    }
  })()
  return {
    stop: async () => {
      stopped = true
      await work
      return peaks
    },
  }
}
