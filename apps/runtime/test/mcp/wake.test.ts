import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Internal, ResidentInactive } from '../../src/http/errors.ts'
import { mcpEventsWake } from '../../src/mcp/wake.ts'
import { Events } from '../../src/mcp/service.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import type { RunProgram } from '../../src/runtime/bridge.ts'
import { stub } from '../http/api/fixture.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The wake over Events whose sweep ends with `sweep`, run as the bridge runs it: failures reject. */
const wakeWith = async (sweep: Effect.Effect<void, Internal | ResidentInactive>) => {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line))
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line))
  const events = stub(Events, { maintain: () => sweep })
  // SAFETY: the wake's program needs only Events, which `events` provides; the cast stands in for the agent's services.
  const run = ((program: Effect.Effect<unknown, Internal | ResidentInactive, Events>) =>
    Effect.runPromise(program.pipe(Effect.provide(Layer.merge(events, ReporterLive))))) as RunProgram
  const scheduled: number[] = []
  await mcpEventsWake(run, async (at) => void scheduled.push(at))
  return { scheduled, failures: lines.map((line): unknown => JSON.parse(line)) }
}

describe('the Events alarm (unit)', () => {
  it('reports a failed sweep, then tries it again in a minute', async () => {
    const before = Date.now()
    const { scheduled, failures } = await wakeWith(Effect.fail(new Internal({ reason: 'sweep broke' })))
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toBeGreaterThanOrEqual(before + 60_000)
    expect(failures).toEqual([
      expect.objectContaining({ event: 'failure', where: 'mcp.events.wake', 'error.type': 'Internal' }),
    ])
    expect(JSON.stringify(failures)).not.toContain('sweep broke')
  })

  it('reschedules without a report when the owner revoked authority, and does nothing after a good sweep', async () => {
    const revoked = await wakeWith(Effect.fail(new ResidentInactive({ state: 'revoked' })))
    expect(revoked.scheduled).toHaveLength(1)
    expect(revoked.failures).toEqual([])
    expect(await wakeWith(Effect.void)).toEqual({ scheduled: [], failures: [] })
  })
})
