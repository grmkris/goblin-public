import { describe, expect, it, vi } from 'vitest'
import {
  ConversationStream,
  reconnectDelay,
  type PiEventSource,
  type ReconnectScheduler,
} from '../src/lib/conversation-stream.ts'
import type { ConversationQueue } from '@goblin/contracts'
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
        queue: async () => ({ inputs: [] }),
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
      { snapshot: async () => snapshot, queue: async () => ({ inputs: [] }), events: () => source },
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
        queue: async () => ({ inputs: [] }),
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
  it('reports a frame it cannot read, keeps what it showed and starts again from a fresh snapshot', async () => {
    const reported: unknown[] = []
    vi.stubGlobal('reportError', (error: unknown) => reported.push(error))
    const streams: FixtureEvents[] = []
    const scheduled: (() => void)[] = []
    const statuses: (string | undefined)[] = []
    const states: ConversationProjection[] = []
    const connection = new ConversationStream(
      {
        snapshot: async () => snapshot,
        queue: async () => ({ inputs: [] }),
        events: () => {
          const source = new FixtureEvents()
          streams.push(source)
          return source
        },
      },
      (state) => states.push(state),
      (status, detail) => statuses.push(detail ?? status),
      {
        schedule: (run) => {
          scheduled.push(run)
          return () => undefined
        },
      },
    )
    try {
      await connection.reconnect()
      const shown = states.length
      streams[0]?.emit('batch', { type: 'run_start' })
      expect(reported).toHaveLength(1)
      expect(states).toHaveLength(shown)
      expect(streams[0]?.closed).toBe(true)
      expect(statuses.at(-1)).toBe('Stream data could not be read')
      scheduled[0]?.()
      await Promise.resolve()
      await Promise.resolve()
      expect(streams).toHaveLength(2)
      expect(statuses.at(-1)).toBe('connected')
    } finally {
      connection.dispose()
      vi.unstubAllGlobals()
    }
  })
  it('caps the backoff at thirty seconds plus jitter', () => {
    expect(reconnectDelay(0, 0)).toBe(1000)
    expect(reconnectDelay(10, 0)).toBe(30_000)
    expect(reconnectDelay(10, 1)).toBe(36_000)
  })
})

describe('native queue content reads', () => {
  it('keeps duplicate text in native order, refetches on inbox events, and rejects superseded/disposed responses', async () => {
    const source = new FixtureEvents()
    const reads: { signal: AbortSignal; resolve: (value: ConversationQueue) => void }[] = []
    let state: ConversationProjection | undefined
    const refs = [
      { id: 5, mode: 'followUp' },
      { id: 6, mode: 'followUp' },
    ]
    const connection = new ConversationStream(
      {
        snapshot: async () => ({ ...snapshot, inbox: refs }),
        events: () => source,
        queue: (signal) => new Promise((resolve) => reads.push({ signal, resolve })),
      },
      (next) => {
        state = next
      },
      () => undefined,
    )
    await connection.reconnect()
    source.emit('snapshot', { ...snapshot, inbox: refs })
    expect(reads[0]?.signal.aborted).toBe(true)
    reads[1]?.resolve({
      inputs: [
        { id: 6, mode: 'followUp', content: 'same' },
        { id: 5, mode: 'followUp', content: 'same' },
      ],
    })
    await Promise.resolve()
    expect(state?.queued.map((item) => item.id)).toEqual([5, 6])
    source.emit('batch', [{ type: 'inbox_update', items: [{ id: 6, mode: 'followUp' }] }])
    expect(state?.queued.map((item) => item.id)).toEqual([6])
    reads[0]?.resolve({ inputs: [{ id: 5, mode: 'followUp', content: 'stale' }] })
    await Promise.resolve()
    expect(state?.queued.map((item) => item.id)).toEqual([6])
    source.emit('batch', [{ type: 'inbox_update', items: [] }])
    reads[2]?.resolve({ inputs: [{ id: 5, mode: 'followUp', content: 'placed' }] })
    await Promise.resolve()
    expect(state?.queued).toEqual([])
    connection.dispose()
    reads[3]?.resolve({ inputs: [{ id: 6, mode: 'followUp', content: 'disposed' }] })
    await Promise.resolve()
    expect(state?.queued).toEqual([])
  })
  it('retains last-known contents on a failed read, retries without a second SSE, and refreshes after reconnect', async () => {
    const sources: FixtureEvents[] = []
    const retries = new Set<() => void>()
    const scheduler: ReconnectScheduler = {
      schedule: (run) => {
        retries.add(run)
        return () => {
          retries.delete(run)
        }
      },
    }
    let fail = false
    let state: ConversationProjection | undefined
    const connection = new ConversationStream(
      {
        snapshot: async () => ({ ...snapshot, inbox: [{ id: 9, mode: 'followUp' }] }),
        queue: async () => {
          if (fail) throw new Error('offline')
          return { inputs: [{ id: 9, mode: 'followUp', content: 'kept' }] }
        },
        events: () => {
          const source = new FixtureEvents()
          sources.push(source)
          return source
        },
      },
      (next) => {
        state = next
      },
      () => undefined,
      scheduler,
    )
    await connection.reconnect()
    await Promise.resolve()
    fail = true
    await connection.refreshQueue()
    expect(state?.queued[0]?.content).toBe('kept')
    expect(state?.queueNotice).toContain('Retrying')
    expect(sources).toHaveLength(1)
    fail = false
    for (const retry of retries) retry()
    await Promise.resolve()
    expect(state?.queueNotice).toBe('')
    await connection.reconnect()
    await Promise.resolve()
    expect(sources).toHaveLength(2)
    expect(sources[0]?.closed).toBe(true)
    expect(state?.queued[0]?.content).toBe('kept')
    connection.dispose()
    expect(retries.size).toBe(0)
  })
})
