import { describe, expect, it } from 'vitest'
import type { AppView, ConversationView } from '@goblin/contracts'
import type { PiEventSource, ReconnectScheduler } from '../src/lib/conversation-stream.ts'
import {
  EMPTY_WORKSPACE,
  WorkspaceFeedConnection,
  type WorkspaceState,
  activityState,
  applyChanges,
  decodeChanges,
  decodeSnapshot,
  fromSnapshot,
  withPendingApps,
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

const app = (id: string, extra: Partial<AppView> = {}): AppView => ({
  id,
  conversation: '1',
  source: { kind: 'mcp', callId: `call-${id}`, serverId: 'notes', tool: 'board', uri: 'ui://notes/board.html' },
  title: 'Board',
  createdAt: Number(id),
  ...extra,
})

describe('the workspace feed state', () => {
  it('starts from the snapshot in order of creation and keeps only what is not idle', () => {
    const state = fromSnapshot({
      conversations: [view('5'), MAIN],
      activity: [
        { id: '5', state: 'working', since: 1 },
        { id: '1', state: 'idle', since: 1 },
      ],
      apps: [],
    })
    expect(state.conversations.map(({ id }) => id)).toEqual(['1', '5'])
    expect(activityState(state, '5')).toBe('working')
    expect(activityState(state, '1')).toBe('idle')
    expect(state.activity.has('1')).toBe(false)
  })

  it('replaces a conversation by id, adds a new one in order, and moves activity in order', () => {
    const start = fromSnapshot({ conversations: [MAIN, view('9')], activity: [], apps: [] })
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

  it('keeps Apps by id, in order, and replaces one that changed (closed)', () => {
    const start = fromSnapshot({ conversations: [MAIN], activity: [], apps: [app('7'), app('3')] })
    expect(start.apps.map(({ id }) => id)).toEqual(['3', '7'])
    const next = applyChanges(start, [
      { type: 'app', app: app('5') },
      { type: 'app', app: app('7', { closedAt: 9 }) },
    ])
    expect(next.apps.map(({ id }) => id)).toEqual(['3', '5', '7'])
    expect(next.apps.at(-1)?.closedAt).toBe(9)
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

describe('reading a newer server', () => {
  it('skips a change kind or an item it cannot read, and keeps the rest in order', () => {
    const unknown = { type: 'app-state', app: '3', revision: 4 }
    const changes = decodeChanges([
      { type: 'conversation', conversation: view('5') },
      unknown,
      { type: 'conversation', conversation: { id: 'not digits' } },
      { type: 'activity', activity: { id: '5', state: 'working', since: 1 } },
    ])
    expect(changes.map((change) => change.type)).toEqual(['conversation', 'activity'])
    const snapshot = decodeSnapshot({ conversations: [MAIN, { id: 'x' }], activity: [unknown], apps: [{}] })
    expect(snapshot).toEqual({ conversations: [MAIN], activity: [], apps: [] })
  })

  it('still refuses a frame of another shape', () => {
    expect(() => decodeChanges({ type: 'conversation' })).toThrow()
    expect(() => decodeSnapshot({ conversations: 'nope', activity: [], apps: [] })).toThrow()
  })
})

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
    first?.emit('snapshot', JSON.stringify({ conversations: [MAIN], activity: [], apps: [] }))
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('5') }]))
    expect(states.at(-1)?.conversations.map(({ id }) => id)).toEqual(['1', '5'])
    first?.errorListener?.()
    expect(first?.closed).toBe(true)
    expect(problems.at(-1)).toBe('Connection interrupted')
    queued.shift()?.()
    sources[1]?.emit('snapshot', JSON.stringify({ conversations: [MAIN], activity: [], apps: [] }))
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

describe('Apps the owner just changed', () => {
  it('stay as the owner left them through unrelated feed changes, until the feed shows them so', () => {
    const open = fromSnapshot({ conversations: [MAIN], activity: [], apps: [app('4'), app('5')] })
    const closing = new Map([['4', app('4', { closedAt: 9 })]])
    const meanwhile = applyChanges(open, [{ type: 'activity', activity: { id: '1', state: 'working', since: 2 } }])
    const shown = withPendingApps(meanwhile, closing)
    expect(shown.state.apps.find(({ id }) => id === '4')?.closedAt).toBe(9)
    expect(shown.state.apps.find(({ id }) => id === '5')?.closedAt).toBeUndefined()
    expect(shown.settled).toEqual([])
    const confirmed = applyChanges(meanwhile, [{ type: 'app', app: app('4', { closedAt: 10 }) }])
    expect(withPendingApps(confirmed, closing)).toEqual({ state: confirmed, settled: ['4'] })
  })
  it('show an App just kept before the feed lists it, and stop once it does', () => {
    const empty = fromSnapshot({ conversations: [MAIN], activity: [], apps: [] })
    const keeping = new Map([['6', app('6')]])
    expect(withPendingApps(empty, keeping).state.apps.map(({ id }) => id)).toEqual(['6'])
    const listed = applyChanges(empty, [{ type: 'app', app: app('6') }])
    expect(withPendingApps(listed, keeping).settled).toEqual(['6'])
  })
})
