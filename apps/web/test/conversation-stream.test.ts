import { describe, expect, it } from 'vitest'
import { ConversationStream, type PiEventSource } from '../src/lib/conversation-stream.ts'
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
    expect(states.at(-1)?.messages.messages).toEqual([])
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
    expect(state?.messages.messages[0]).toMatchObject({ content: 'Committed during attachment' })
    connection.dispose()
  })
})
