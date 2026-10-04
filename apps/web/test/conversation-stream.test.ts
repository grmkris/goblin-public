import { describe, expect, it } from 'vitest'
import {
  ConversationStream,
  reconnectDelay,
  type PiEventSource,
  type ReconnectScheduler,
} from '../src/lib/conversation-stream.ts'
import type { ConversationProjection } from '../src/lib/projection.ts'

class FixtureEvents implements PiEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
  closed = false
  errorListener: (() => void) | undefined
  onError(listener: () => void): void {
    this.errorListener = listener
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener)
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }))
  }
}
const snapshot = { type: 'snapshot', entries: [], tools: [], inbox: [] }
describe('snapshot reconnection', () => {
  it('disposes the old stream and ignores its late commits after reconnect', async () => {
    const streams: FixtureEvents[] = []
    const states: ConversationProjection[] = []
    const controllerSignals: AbortSignal[] = []
    const connection = new ConversationStream(
      {
        snapshot: async (signal) => {
          controllerSignals.push(signal)
          return snapshot
        },
        events: () => {
          const source = new FixtureEvents()
          streams.push(source)
          return source
        },
      },
      (state) => states.push(state),
      () => undefined,
    )
    await connection.reconnect()
    streams[0]?.emit('batch', [
      { type: 'entry_appended', entry: { id: 1, model: [{ role: 'user', content: 'earlier' }] } },
    ])
    await connection.reconnect()
    expect(streams[0]?.closed).toBe(true)
    expect(controllerSignals[0]?.aborted).toBe(true)
    const count = states.length
    streams[0]?.emit('batch', [{ type: 'run_start' }])
    expect(states).toHaveLength(count)
    expect(states.at(-1)?.messages).toEqual([])
    connection.dispose()
    expect(streams[1]?.closed).toBe(true)
  })
  it('uses the atomically attached Pi stream snapshot to close the fetch/attach race', async () => {
    const source = new FixtureEvents()
    let state: ConversationProjection | undefined
    const connection = new ConversationStream(
      { snapshot: async () => snapshot, events: () => source },
      (value) => {
        state = value
      },
      () => undefined,
    )
    await connection.reconnect()
    source.emit('snapshot', {
      ...snapshot,
      entries: [
        { id: 2, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Committed during attachment' }] }] },
      ],
    })
    expect(state?.messages[0]).toMatchObject({ text: 'Committed during attachment' })
    connection.dispose()
  })
  it('reconnects on its own with backoff through a fresh snapshot, and stops when disposed', async () => {
    const streams: FixtureEvents[] = []
    const scheduled: { run: () => void; delay: number }[] = []
    const scheduler: ReconnectScheduler = {
      schedule: (run, delay) => {
        scheduled.push({ run, delay })
        return () => undefined
      },
    }
    let snapshots = 0
    const statuses: string[] = []
    const connection = new ConversationStream(
      {
        snapshot: async () => {
          snapshots += 1
          if (snapshots === 2) throw new Error('offline')
          return snapshot
        },
        events: () => {
          const source = new FixtureEvents()
          streams.push(source)
          return source
        },
      },
      () => undefined,
      (status) => statuses.push(status),
      scheduler,
    )
    await connection.reconnect()
    streams[0]?.errorListener?.()
    expect(streams[0]?.closed).toBe(true)
    expect(scheduled).toHaveLength(1)
    scheduled[0]?.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduled).toHaveLength(2)
    expect(scheduled[1]?.delay).toBeGreaterThan(scheduled[0]?.delay ?? 0)
    scheduled[1]?.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(snapshots).toBe(3)
    expect(statuses.at(-1)).toBe('connected')
    connection.dispose()
    streams.at(-1)?.errorListener?.()
    expect(scheduled).toHaveLength(2)
  })
  it('caps the backoff at thirty seconds plus jitter', () => {
    expect(reconnectDelay(0, 0)).toBe(1000)
    expect(reconnectDelay(10, 0)).toBe(30_000)
    expect(reconnectDelay(10, 1)).toBe(36_000)
  })
})
