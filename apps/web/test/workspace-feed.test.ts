import { describe, expect, it } from 'vitest'
import type { ConversationView } from '@purrable/contracts'
import type { PiEventSource, ReconnectScheduler } from '../src/lib/conversation-stream.ts'
import {
  EMPTY_WORKSPACE,
  WorkspaceFeedConnection,
  type WorkspaceState,
  activityState,
  applyChanges,
  fromSnapshot,
} from '../src/lib/workspace-feed.ts'

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  keepOpen: false,
  replies: 0,
  createdAt: Number(id),
  ...extra,
})
const MAIN = view('1', { kind: 'main', createdAt: 0 })

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
  emit(type: string, data: string): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }))
  }
}

describe('the workspace feed state', () => {
  it('starts from the snapshot in order of creation and keeps only what is not idle', () => {
    const state = fromSnapshot({
      conversations: [view('5'), MAIN],
      activity: [
        { id: '5', state: 'working', since: 1 },
        { id: '1', state: 'idle', since: 1 },
      ],
    })
    expect(state.conversations.map(({ id }) => id)).toEqual(['1', '5'])
    expect(activityState(state, '5')).toBe('working')
    expect(activityState(state, '1')).toBe('idle')
    expect(state.activity.has('1')).toBe(false)
  })

  it('replaces a conversation by id, adds a new one in order, and moves activity in order', () => {
    const start = fromSnapshot({ conversations: [MAIN, view('9')], activity: [] })
    const next = applyChanges(start, [
      { type: 'conversation', conversation: view('5') },
      { type: 'conversation', conversation: view('9', { title: 'Car search', replies: 2 }) },
      { type: 'activity', activity: { id: '9', state: 'working', since: 2 } },
      { type: 'activity', activity: { id: '1', state: 'waiting', since: 3 } },
      { type: 'activity', activity: { id: '9', state: 'idle', since: 4 } },
    ])
    expect(next.conversations.map(({ id }) => id)).toEqual(['1', '5', '9'])
    expect(next.conversations.at(-1)).toMatchObject({ title: 'Car search', replies: 2 })
    expect(activityState(next, '9')).toBe('idle')
    expect(activityState(next, '1')).toBe('waiting')
    expect(start.conversations).toHaveLength(2)
  })
})

/** A scheduler the test runs by hand: each retry waits in `queued` until called. */
function manual() {
  const queued: (() => void)[] = []
  const scheduler: ReconnectScheduler = {
    schedule: (run) => {
      queued.push(run)
      return () => queued.splice(queued.indexOf(run), 1)
    },
  }
  return { queued, scheduler }
}

describe('the workspace feed connection', () => {
  it('publishes the snapshot, then changes, and starts again from a fresh snapshot after an error', () => {
    const sources: FixtureEvents[] = []
    const states: WorkspaceState[] = []
    const problems: (string | undefined)[] = []
    const { queued, scheduler } = manual()
    const connection = new WorkspaceFeedConnection(
      () => {
        const source = new FixtureEvents()
        sources.push(source)
        return source
      },
      (state) => states.push(state),
      (problem) => problems.push(problem),
      scheduler,
    )
    connection.connect()
    const first = sources[0]
    // A change before any snapshot has nothing to apply to.
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('5') }]))
    expect(states).toEqual([])
    first?.emit('snapshot', JSON.stringify({ conversations: [MAIN], activity: [] }))
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('5') }]))
    expect(states.at(-1)?.conversations.map(({ id }) => id)).toEqual(['1', '5'])
    first?.errorListener?.()
    expect(first?.closed).toBe(true)
    expect(problems.at(-1)).toBe('Connection interrupted')
    queued.shift()?.()
    sources[1]?.emit('snapshot', JSON.stringify({ conversations: [MAIN], activity: [] }))
    expect(states.at(-1)?.conversations.map(({ id }) => id)).toEqual(['1'])
    expect(problems.at(-1)).toBeUndefined()
    // The old stream's late frames are ignored.
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('7') }]))
    expect(states.at(-1)?.conversations).toHaveLength(1)
    connection.dispose()
    expect(sources[1]?.closed).toBe(true)
  })

  it('reconnects when a frame cannot be read, and stops for good once disposed', () => {
    const sources: FixtureEvents[] = []
    const { queued, scheduler } = manual()
    const connection = new WorkspaceFeedConnection(
      () => {
        const source = new FixtureEvents()
        sources.push(source)
        return source
      },
      () => undefined,
      () => undefined,
      scheduler,
    )
    connection.connect()
    sources[0]?.emit('snapshot', '{"conversations":"nope"}')
    expect(sources[0]?.closed).toBe(true)
    expect(queued).toHaveLength(1)
    connection.dispose()
    expect(queued).toHaveLength(0)
    expect(EMPTY_WORKSPACE.conversations).toEqual([])
  })
})
