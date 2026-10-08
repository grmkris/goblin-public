import { describe, expect, it } from 'vitest'
import type { PiEventSource, ReconnectScheduler } from '../src/lib/conversation-stream.ts'
import { type StreamState, StreamPool } from '../src/lib/stream-pool.ts'

class FixtureEvents implements PiEventSource {
  closed = false
  addEventListener(): void {}
  onError(): void {}
  close(): void {
    this.closed = true
  }
}

/** Timers that run only when the test says so. */
class Clock implements ReconnectScheduler {
  now = 0
  readonly #timers = new Set<{ at: number; run: () => void }>()
  schedule = (run: () => void, delayMs: number) => {
    const timer = { at: this.now + delayMs, run }
    this.#timers.add(timer)
    return () => void this.#timers.delete(timer)
  }
  advance(ms: number): void {
    this.now += ms
    for (const timer of [...this.#timers].filter(({ at }) => at <= this.now)) {
      this.#timers.delete(timer)
      timer.run()
    }
  }
}

const snapshot = { type: 'snapshot', entries: [], tools: [], inbox: [] }

function fixture(max = 8) {
  const clock = new Clock()
  const opened: Record<string, FixtureEvents[]> = {}
  const pool = new StreamPool(
    (id) => ({
      snapshot: async () => snapshot,
      queue: async () => ({ inputs: [] }),
      events: () => {
        const source = new FixtureEvents()
        opened[id] = [...(opened[id] ?? []), source]
        return source
      },
    }),
    { max, idleMs: 10_000, scheduler: clock, now: () => clock.now },
  )
  return { clock, opened, pool }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the stream pool', () => {
  it('shares one stream among everyone following a conversation, until the last lets go', async () => {
    const { opened, pool } = fixture()
    const seen: StreamState[] = []
    const pane = pool.acquire('7', true, (state) => seen.push(state))
    const inline = pool.acquire('7', true, () => undefined)
    await settle()
    expect(opened['7']).toHaveLength(1)
    expect(seen.at(-1)?.status).toBe('connected')
    pane.release()
    expect(opened['7']?.[0]?.closed).toBe(false)
    inline.release()
    expect(opened['7']?.[0]?.closed).toBe(true)
    expect(pool.live).toBe(0)
  })

  it('suspends a conversation nobody has on screen after a while, and resumes it from a fresh snapshot', async () => {
    const { clock, opened, pool } = fixture()
    const states: StreamState[] = []
    const lease = pool.acquire('7', true, (state) => states.push(state))
    await settle()
    lease.setVisible(false)
    clock.advance(9_000)
    expect(pool.live).toBe(1)
    lease.setVisible(true)
    clock.advance(10_000)
    expect(pool.live).toBe(1)
    lease.setVisible(false)
    clock.advance(10_000)
    expect(pool.live).toBe(0)
    expect(states.at(-1)?.status).toBe('suspended')
    expect(opened['7']?.[0]?.closed).toBe(true)
    lease.setVisible(true)
    await settle()
    expect(opened['7']).toHaveLength(2)
    expect(states.at(-1)?.status).toBe('connected')
  })

  it('keeps within its cap by suspending the least recently seen, never one on screen', async () => {
    const { clock, pool } = fixture(2)
    const old = pool.acquire('1', true, () => undefined)
    clock.advance(10)
    const newer = pool.acquire('2', true, () => undefined)
    await settle()
    old.setVisible(false)
    newer.setVisible(false)
    const states: StreamState[] = []
    pool.acquire('3', true, () => undefined)
    pool.acquire('1', false, (state) => states.push(state))
    expect(pool.live).toBe(2)
    expect(states.at(-1)?.status).toBe('suspended')
    pool.acquire('4', true, () => undefined)
    pool.acquire('5', true, () => undefined)
    expect(pool.live).toBe(3)
  })
})
