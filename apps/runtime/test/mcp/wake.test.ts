import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Internal, ResidentInactive } from '../../src/http/errors.ts'
import { mcpEventsWake } from '../../src/mcp/wake.ts'
import { Events } from '../../src/mcp/service.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'
import { plans, stub } from '../http/api/fixture.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The wake over Events whose sweep ends with `sweep`, on an account whose plan is `active`; `due` is when the store's
 * next work is (`null`: nothing waits).
 */
const wakeWith = async (
  sweep: Effect.Effect<void, Internal | ResidentInactive>,
  active = true,
  due: number | null = 0,
) => {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line))
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line))
  const scheduled: number[] = []
  // SAFETY: the wake reads only `scheduleEvents` from the agent's inputs.
  const input = { scheduleEvents: async (at: number) => void scheduled.push(at) } as AgentInputs
  const services = Layer.mergeAll(
    stub(Events, { maintain: () => sweep, nextDue: () => Effect.succeed(due ?? undefined) }),
    ReporterLive,
    plans(active),
    Layer.succeed(AgentInput, input),
  )
  await Effect.runPromise(mcpEventsWake.pipe(Effect.provide(services)))
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

  it('keeps no alarm after a failure when nothing waits', async () => {
    const idle = await wakeWith(Effect.fail(new Internal({ reason: 'sweep broke' })), true, null)
    expect(idle.scheduled).toEqual([])
    const lapsed = await wakeWith(Effect.void, false, null)
    expect(lapsed.scheduled).toEqual([])
  })

  it('sweeps nothing without an active plan, and tries again in a minute', async () => {
    const swept: number[] = []
    const lapsed = await wakeWith(
      Effect.sync(() => void swept.push(1)),
      false,
    )
    expect(swept).toEqual([])
    expect(lapsed).toMatchObject({ scheduled: [expect.any(Number)], failures: [] })
  })
})
