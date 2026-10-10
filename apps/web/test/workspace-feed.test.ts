import {
  MutationObserver,
  QueryObserver,
  type QueryClient,
  type QueryKey,
  type QueryObserverOptions,
} from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppView, type ConversationView, EVERYTHING, type WorkspaceSnapshot } from '@goblin/contracts'
import { usageQuery } from '../src/agent/queries.ts'
import { agentAppQuery, agentAppsQuery } from '../src/agent-apps/queries.ts'
import { capabilitiesQuery } from '../src/capabilities/queries.ts'
import { conversationKeys } from '../src/conversations/queries.ts'
import type { PiEventSource, ReconnectScheduler } from '../src/lib/conversation-stream.ts'
import { testQueryClient } from '../src/lib/query/testing.ts'
import { WorkspaceFeedConnection } from '../src/lib/workspace/connection.ts'
import { decodeChanges, decodeSnapshot } from '../src/lib/workspace/decode.ts'
import { type Cached, staleAfter } from '../src/lib/workspace/invalidations.ts'
import {
  closeWorkspaceAppMutation,
  keepWorkspaceAppMutation,
  markReadWorkspaceMutation,
} from '../src/lib/workspace/mutations.ts'
import { EMPTY_WORKSPACE, activityOf, applyChanges, fromSnapshot } from '../src/lib/workspace/slices.ts'
import { workspaceQueries, workspaceSync } from '../src/lib/workspace/sync.ts'
import { personaKeys } from '../src/personas/queries.ts'

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
const TOPIC = {
  id: 1,
  name: 'Personal',
  conversation: '1',
  searchExcluded: false,
  revision: 0,
  setup: EVERYTHING,
  createdBy: 'system' as const,
  createdAt: 0,
}

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
const agentApp = (id: string, name: string, revision: number): AppView => ({
  ...app(id),
  source: { kind: 'agent', name, release: 'r1', version: 1, revision, jobs: [] },
})

const CRITIC = {
  id: 4,
  name: 'Critic',
  avatar: { glyph: 'C', hue: 20 },
  role: 'Finds the weak spot',
  instructions: 'Be blunt.',
  setup: { mcpServers: [], skills: [], apps: [] },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}
const asking = (order: number, state: 'pending' | 'running' | 'answered') => ({
  operationId: 'op-1',
  persona: order,
  revision: 1,
  chat: '1',
  order,
  state,
  createdAt: 1,
})
const receipt = (id: string, at: number) => ({
  id,
  kind: 'topic.create' as const,
  target: '2',
  summary: 'Created Japan',
  actor: 'agent' as const,
  at,
  undoable: true,
})
const working = (id: string, since = 1) => ({ id, state: 'working' as const, since })
const snapshot = (extra: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  conversations: [MAIN],
  activity: [],
  apps: [],
  ...extra,
})

describe('the workspace slices', () => {
  it('start from the snapshot in order of creation and keep only the activity that is not idle', () => {
    const slices = fromSnapshot(
      snapshot({ conversations: [view('5'), MAIN], activity: [working('5'), { id: '1', state: 'idle', since: 1 }] }),
    )
    expect(slices.conversations.map(({ id }) => id)).toEqual(['1', '5'])
    expect(activityOf(slices.activity, '5')?.state).toBe('working')
    expect(activityOf(slices.activity, '1')).toBeUndefined()
    expect(Object.keys(slices.activity)).toEqual(['5'])
  })

  it('replace a conversation by id, add a new one in order, and move activity in order', () => {
    const start = fromSnapshot(snapshot({ conversations: [MAIN, view('9')] }))
    const next = applyChanges(start, [
      { type: 'conversation', conversation: view('5') },
      { type: 'conversation', conversation: view('9', { title: 'Car search', replies: 2 }) },
      { type: 'activity', activity: working('9', 2) },
      { type: 'activity', activity: { id: '1', state: 'waiting', since: 3 } },
      { type: 'activity', activity: { id: '9', state: 'idle', since: 4 } },
    ])
    expect(next.conversations.map(({ id }) => id)).toEqual(['1', '5', '9'])
    expect(next.conversations.at(-1)).toMatchObject({ title: 'Car search', replies: 2 })
    expect(activityOf(next.activity, '9')).toBeUndefined()
    expect(activityOf(next.activity, '1')?.state).toBe('waiting')
    expect(start.conversations).toHaveLength(2)
  })

  it('keep Apps by id, in order, and replace one that changed (closed)', () => {
    const start = fromSnapshot(snapshot({ apps: [app('7'), app('3')] }))
    expect(start.apps.map(({ id }) => id)).toEqual(['3', '7'])
    const next = applyChanges(start, [
      { type: 'app', app: app('5') },
      { type: 'app', app: app('7', { closedAt: 9 }) },
    ])
    expect(next.apps.map(({ id }) => id)).toEqual(['3', '5', '7'])
    expect(next.apps.at(-1)?.closedAt).toBe(9)
  })

  it('leave every other slice the same value for a change of one kind', () => {
    const start = fromSnapshot(snapshot({ apps: [app('3')] }))
    const japan = { ...TOPIC, id: 2, name: 'Japan', conversation: '7', revision: 1, createdBy: 'owner' as const }
    const next = applyChanges(start, [{ type: 'topic', topic: japan }])
    expect(next.conversations).toBe(start.conversations)
    expect(next.apps).toBe(start.apps)
    expect(next.activity).toBe(start.activity)
    expect(next.topics).not.toBe(start.topics)
  })

  it('keep Topics, Personas, Persona answers on their way and receipts from changes, in their orders', () => {
    const start = fromSnapshot(snapshot())
    const japan = { ...TOPIC, id: 2, name: 'Japan', conversation: '7' }
    const next = applyChanges(start, [
      { type: 'topic', topic: japan },
      { type: 'topic', topic: { ...TOPIC, personal: true } },
      { type: 'topic', topic: { ...japan, name: 'Japan 2027' } },
      { type: 'persona', persona: CRITIC },
      { type: 'invocation', invocation: asking(2, 'pending') },
      { type: 'invocation', invocation: asking(1, 'running') },
      { type: 'invocation', invocation: asking(2, 'answered') },
      { type: 'receipt', receipt: receipt('r1', 5) },
      { type: 'receipt', receipt: receipt('r2', 9) },
    ])
    expect(next.topics.map(({ id, name }) => [id, name])).toEqual([
      [1, 'Personal'],
      [2, 'Japan 2027'],
    ])
    expect(next.personas.map(({ name }) => name)).toEqual(['Critic'])
    expect(next.invocations.map(({ persona, state }) => [persona, state])).toEqual([
      [1, 'running'],
      [2, 'answered'],
    ])
    expect(next.receipts.map(({ id }) => id)).toEqual(['r2', 'r1'])
    expect(start.topics).toEqual([])
  })

  it('read the Topics a snapshot lists, and none from a server without them', () => {
    const decoded = decodeSnapshot({ conversations: [MAIN], activity: [], apps: [], topics: [TOPIC, { id: 'x' }] })
    expect(decoded.topics).toEqual([TOPIC])
    expect(fromSnapshot(decoded).topics).toEqual([TOPIC])
    expect(decodeSnapshot({ conversations: [], activity: [], apps: [] })).not.toHaveProperty('topics')
  })

  it('drop an App the owner deleted', () => {
    const start = fromSnapshot(snapshot({ apps: [app('3'), app('7')] }))
    const next = applyChanges(start, [{ type: 'app-removed', id: '3' }])
    expect(next.apps.map(({ id }) => id)).toEqual(['7'])
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
      { type: 'activity', activity: working('5') },
    ])
    expect(changes.map((change) => change.type)).toEqual(['conversation', 'activity'])
    const decoded = decodeSnapshot({ conversations: [MAIN, { id: 'x' }], activity: [unknown], apps: [{}] })
    expect(decoded).toEqual({ conversations: [MAIN], activity: [], apps: [] })
  })

  it('still refuses a frame of another shape', () => {
    expect(() => decodeChanges({ type: 'conversation' })).toThrow()
    expect(() => decodeSnapshot({ conversations: 'nope', activity: [], apps: [] })).toThrow()
  })
})

/** A connection over fixture streams, with what it delivered. */
function connection() {
  const sources: FixtureEvents[] = []
  const delivered: string[] = []
  const problems: (string | undefined)[] = []
  const { queued, scheduler } = manual()
  const feed = new WorkspaceFeedConnection(
    () => {
      const source = new FixtureEvents()
      sources.push(source)
      return source
    },
    {
      snapshot: (frame) => delivered.push(`snapshot:${frame.conversations.map(({ id }) => id).join(',')}`),
      changes: (changes) => delivered.push(`changes:${changes.map(({ type }) => type).join(',')}`),
      report: (problem) => problems.push(problem),
    },
    scheduler,
  )
  return { feed, sources, delivered, problems, queued }
}

describe('the workspace feed connection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('delivers the snapshot, then changes, and starts again from a fresh snapshot after an error', () => {
    const { feed, sources, delivered, problems, queued } = connection()
    feed.connect()
    const first = sources[0]
    // A change before any snapshot has nothing to apply to.
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('5') }]))
    expect(delivered).toEqual([])
    first?.emit('snapshot', JSON.stringify(snapshot()))
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('5') }]))
    expect(delivered).toEqual(['snapshot:1', 'changes:conversation'])
    first?.errorListener?.()
    expect(first?.closed).toBe(true)
    expect(problems.at(-1)).toBe('Connection interrupted')
    queued.shift()?.()
    // The new stream's changes wait for its own snapshot.
    sources[1]?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('6') }]))
    sources[1]?.emit('snapshot', JSON.stringify(snapshot()))
    expect(delivered.at(-1)).toBe('snapshot:1')
    expect(problems.at(-1)).toBeUndefined()
    // The old stream's late frames are ignored.
    first?.emit('change', JSON.stringify([{ type: 'conversation', conversation: view('7') }]))
    expect(delivered).toHaveLength(3)
    feed.dispose()
    expect(sources[1]?.closed).toBe(true)
  })

  it('reports a frame it cannot read, reconnects, and stops for good once disposed', () => {
    const reported: unknown[] = []
    vi.stubGlobal('reportError', (error: unknown) => reported.push(error))
    const { feed, sources, problems, queued } = connection()
    feed.connect()
    sources[0]?.emit('snapshot', '{"conversations":"nope"}')
    expect(reported).toHaveLength(1)
    expect(problems).toEqual(['Workspace data could not be read'])
    expect(sources[0]?.closed).toBe(true)
    expect(queued).toHaveLength(1)
    feed.dispose()
    expect(queued).toHaveLength(0)
  })
})

const conversationsOf = (client: QueryClient) =>
  client.getQueryData(workspaceQueries.conversations.queryKey)?.map(({ id }) => id)
const appsOf = (client: QueryClient) => client.getQueryData(workspaceQueries.apps.queryKey)

describe('the workspace in the Query cache', () => {
  it('reads each slice once the first snapshot is in, and keeps it current from the feed', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    const reading = client.query(workspaceQueries.conversations)
    sync.snapshot(snapshot({ conversations: [MAIN, view('5')], apps: [app('3')] }))
    expect((await reading).map(({ id }) => id)).toEqual(['1', '5'])
    sync.changes([{ type: 'conversation', conversation: view('7') }])
    expect(conversationsOf(client)).toEqual(['1', '5', '7'])
    expect(appsOf(client)?.map(({ id }) => id)).toEqual(['3'])
  })

  it('waits for the feed rather than reading the server, so a reader answers as an empty workspace meanwhile', async () => {
    const requests: unknown[] = []
    vi.stubGlobal('fetch', (input: unknown) => {
      requests.push(input)
      return new Promise<never>(() => undefined)
    })
    try {
      const client = testQueryClient()
      const observer = new QueryObserver(client, workspaceQueries.topics)
      const stop = observer.subscribe(() => undefined)
      await settled()
      expect(observer.getCurrentResult().status).toBe('pending')
      expect(requests).toEqual([])
      expect(EMPTY_WORKSPACE.topics).toEqual([])
      workspaceSync(client).snapshot(snapshot({ topics: [TOPIC] }))
      await settled()
      expect(observer.getCurrentResult().data).toEqual([TOPIC])
      stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('follows the feed from its stream, and skips an item it cannot read in a change frame', () => {
    const client = testQueryClient()
    const sources: FixtureEvents[] = []
    const stop = workspaceSync(client).connect(() => {
      const source = new FixtureEvents()
      sources.push(source)
      return source
    })
    sources[0]?.emit('snapshot', JSON.stringify(snapshot()))
    const unreadable = { type: 'conversation', conversation: { id: 7 } }
    sources[0]?.emit('change', JSON.stringify([unreadable, { type: 'conversation', conversation: view('8') }]))
    expect(conversationsOf(client)).toEqual(['1', '8'])
    stop()
    expect(sources[0]?.closed).toBe(true)
  })

  it('says what is wrong with the feed, and clears it once a frame arrives', () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.report('Connection interrupted')
    expect(client.getQueryData(workspaceQueries.status.queryKey)).toBe('Connection interrupted')
    sync.report(undefined)
    expect(client.getQueryData(workspaceQueries.status.queryKey)).toBe('')
  })
})

/** A call the test answers by hand: the mutation stays pending until it does. */
function held<A>() {
  const settle: { answer?: (value: A) => void; refuse?: (failure: Error) => void } = {}
  const promise = new Promise<A>((resolve, reject) => {
    settle.answer = resolve
    settle.refuse = reject
  })
  return { promise, answer: (value: A) => settle.answer?.(value), refuse: (failure: Error) => settle.refuse?.(failure) }
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Apps the owner just changed', () => {
  it('stay closed through unrelated changes, a change to the App itself and a reconnect, until the server answers', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ apps: [app('4'), app('5')] }))
    const call = held<AppView>()
    const closing = new MutationObserver(client, { ...closeWorkspaceAppMutation, mutationFn: () => call.promise })
    const done = closing.mutate({ id: '4', closed: true })
    await settled()
    const closedAt = (id: string) => appsOf(client)?.find((each) => each.id === id)?.closedAt
    expect(closedAt('4')).toBeDefined()
    sync.changes([{ type: 'activity', activity: working('1', 2) }])
    sync.changes([{ type: 'app', app: app('4', { title: 'Board, renamed' }) }])
    expect(closedAt('4')).toBeDefined()
    sync.snapshot(snapshot({ apps: [app('4'), app('5')] }))
    expect(closedAt('4')).toBeDefined()
    expect(closedAt('5')).toBeUndefined()
    call.answer(app('4', { closedAt: 10 }))
    await done
    expect(closedAt('4')).toBe(10)
    sync.changes([{ type: 'conversation', conversation: view('6') }])
    expect(closedAt('4')).toBe(10)
  })

  it('show as the feed has them when the server refuses the close, and stay so', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ apps: [app('4')] }))
    const call = held<AppView>()
    const closing = new MutationObserver(client, { ...closeWorkspaceAppMutation, mutationFn: () => call.promise })
    const done = closing.mutate({ id: '4', closed: true })
    await settled()
    expect(appsOf(client)?.[0]?.closedAt).toBeDefined()
    call.refuse(new Error('refused'))
    await expect(done).rejects.toThrow('refused')
    expect(appsOf(client)?.[0]?.closedAt).toBeUndefined()
    sync.changes([{ type: 'activity', activity: working('1', 2) }])
    expect(appsOf(client)?.[0]?.closedAt).toBeUndefined()
  })

  it('stay closed after the server answers, through a stale change, until the feed agrees', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ apps: [app('4')] }))
    const closing = new MutationObserver(client, {
      ...closeWorkspaceAppMutation,
      mutationFn: async () => app('4', { closedAt: 10 }),
    })
    await closing.mutate({ id: '4', closed: true })
    const shown = () => appsOf(client)?.find(({ id }) => id === '4')
    expect(shown()?.closedAt).toBe(10)
    // A change the server made before the close, arriving after its answer: the App stays closed.
    sync.changes([{ type: 'app', app: app('4', { title: 'Board, before' }) }])
    expect(shown()?.closedAt).toBe(10)
    sync.changes([{ type: 'conversation', conversation: view('6') }])
    expect(shown()?.closedAt).toBe(10)
    // The feed agrees: the change is done, and what the feed says next stands.
    sync.changes([{ type: 'app', app: app('4', { closedAt: 11, title: 'Board, closed' }) }])
    expect(shown()).toMatchObject({ closedAt: 11, title: 'Board, closed' })
    sync.changes([{ type: 'app', app: app('4') }])
    expect(shown()?.closedAt).toBeUndefined()
  })

  it('end on a reconnect snapshot that already agrees, or no longer lists the App', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ apps: [app('4'), app('5')] }))
    const answer = (closedAt: number) => async () => app('4', { closedAt })
    await new MutationObserver(client, { ...closeWorkspaceAppMutation, mutationFn: answer(10) }).mutate({
      id: '4',
      closed: true,
    })
    sync.snapshot(snapshot({ apps: [app('4', { closedAt: 10 }), app('5')] }))
    sync.changes([{ type: 'app', app: app('4') }])
    expect(appsOf(client)?.find(({ id }) => id === '4')?.closedAt).toBeUndefined()
    await new MutationObserver(client, { ...closeWorkspaceAppMutation, mutationFn: answer(12) }).mutate({
      id: '4',
      closed: true,
    })
    sync.snapshot(snapshot({ apps: [app('5')] }))
    expect(appsOf(client)?.map(({ id }) => id)).toEqual(['5'])
  })

  it('end at once when the feed agreed before the server answered', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ apps: [app('4')] }))
    const call = held<AppView>()
    const done = new MutationObserver(client, {
      ...closeWorkspaceAppMutation,
      mutationFn: () => call.promise,
    }).mutate({ id: '4', closed: true })
    await settled()
    sync.changes([{ type: 'app', app: app('4', { closedAt: 10 }) }])
    call.answer(app('4', { closedAt: 10 }))
    await done
    sync.changes([{ type: 'app', app: app('4') }])
    expect(appsOf(client)?.[0]?.closedAt).toBeUndefined()
  })

  it('show an App just kept before the feed lists it, until it does', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot())
    const keeping = new MutationObserver(client, { ...keepWorkspaceAppMutation, mutationFn: async () => app('6') })
    await keeping.mutate({ conversation: '1', callId: 'call-6' })
    expect(appsOf(client)?.map(({ id }) => id)).toEqual(['6'])
    sync.changes([{ type: 'activity', activity: working('1', 2) }])
    expect(appsOf(client)?.map(({ id }) => id)).toEqual(['6'])
    sync.changes([{ type: 'app', app: app('6', { title: 'Board, listed' }) }])
    expect(appsOf(client)?.[0]?.title).toBe('Board, listed')
    sync.changes([{ type: 'app-removed', id: '6' }])
    expect(appsOf(client)).toEqual([])
  })

  it('a conversation marked read shows read at once, and a mark the server refused says so', async () => {
    const client = testQueryClient()
    workspaceSync(client).snapshot(snapshot({ conversations: [MAIN, view('5', { lastReplyAt: 50 })] }))
    const marking = new MutationObserver(client, {
      ...markReadWorkspaceMutation,
      mutationFn: () => Promise.reject(new Error('offline')),
    })
    await expect(marking.mutate('5')).rejects.toThrow('offline')
    const read = client.getQueryData(workspaceQueries.conversations.queryKey)?.find(({ id }) => id === '5')?.readAt
    expect(read).toBeGreaterThanOrEqual(50)
    expect(client.getQueryData(workspaceQueries.status.queryKey)).toMatch(/^Could not mark it read/u)
  })
})

const present = (snapshotted: ReturnType<typeof fromSnapshot>): Cached => snapshotted

describe('what goes stale with a feed change', () => {
  const before = fromSnapshot(
    snapshot({ activity: [working('5')], apps: [agentApp('3', 'tracker', 1), app('4')], personas: [CRITIC] }),
  )

  it('is nothing on the first snapshot: nothing was read from an older one', () => {
    const none: Cached = {
      conversations: undefined,
      activity: undefined,
      apps: undefined,
      topics: undefined,
      personas: undefined,
      invocations: undefined,
      receipts: undefined,
      proposals: undefined,
    }
    expect(staleAfter(none, before)).toEqual([])
  })

  it("is a run's end: the conversation's sources and switches, and today's usage", () => {
    const after = applyChanges(before, [{ type: 'activity', activity: { id: '5', state: 'idle', since: 2 } }])
    expect(staleAfter(present(before), after)).toEqual([
      capabilitiesQuery('5').queryKey,
      conversationKeys.sources('5'),
      usageQuery.queryKey,
    ])
    const started = applyChanges(before, [{ type: 'activity', activity: working('6', 2) }])
    expect(staleAfter(present(before), started)).toEqual([capabilitiesQuery('6').queryKey])
  })

  it('is an agent app that changed or went: the list and its page; an MCP App changes nothing read', () => {
    const changed = applyChanges(before, [{ type: 'app', app: agentApp('3', 'tracker', 2) }])
    expect(staleAfter(present(before), changed)).toEqual([agentAppsQuery.queryKey, agentAppQuery('tracker').queryKey])
    const gone = applyChanges(before, [{ type: 'app-removed', id: '3' }])
    expect(staleAfter(present(before), gone)).toEqual([agentAppsQuery.queryKey, agentAppQuery('tracker').queryKey])
    const closed = applyChanges(before, [{ type: 'app', app: app('4', { closedAt: 3 }) }])
    expect(staleAfter(present(before), closed)).toEqual([])
  })

  it('is a Persona that changed: the Persona reads and what composers can tag', () => {
    const after = applyChanges(before, [{ type: 'persona', persona: { ...CRITIC, revision: 2 } }])
    expect(staleAfter(present(before), after)).toEqual([personaKeys.all, conversationKeys.composers])
  })

  it('is read again through the cache when the feed sends it', () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ activity: [working('5')] }))
    const usage = client.getQueryCache().build(client, { queryKey: usageQuery.queryKey })
    expect(usage.state.isInvalidated).toBe(false)
    sync.changes([{ type: 'activity', activity: { id: '5', state: 'idle', since: 2 } }])
    expect(usage.state.isInvalidated).toBe(true)
  })
})

/**
 * How often a reader of the cache is told to render: what `useQuery` subscribes with, tracking `status` and `data` as
 * the slice hooks read them (`lib/workspace/hooks.ts`).
 */
function renders<Data, Selected, Key extends QueryKey>(
  client: QueryClient,
  options: QueryObserverOptions<Data, Error, Selected, Data, Key>,
) {
  const observer = new QueryObserver(client, { ...options, notifyOnChangeProps: ['status', 'data'] })
  const count = { renders: 0 }
  const stop = observer.subscribe(() => {
    count.renders += 1
  })
  return Object.assign(count, { stop, observer })
}

describe('which readers render for a feed change', () => {
  it('renders no App reader for a conversation change, and only that conversation activity reader for its activity', async () => {
    const client = testQueryClient()
    const sync = workspaceSync(client)
    sync.snapshot(snapshot({ conversations: [MAIN, view('5'), view('6')], apps: [app('3')] }))
    const apps = [renders(client, workspaceQueries.apps), renders(client, workspaceQueries.apps)]
    const five = renders(client, { ...workspaceQueries.activity, select: (activity) => activityOf(activity, '5') })
    const six = renders(client, { ...workspaceQueries.activity, select: (activity) => activityOf(activity, '6') })
    await settled()
    for (const reader of [...apps, five, six]) reader.renders = 0
    sync.changes([{ type: 'conversation', conversation: view('5', { title: 'Renamed' }) }])
    await settled()
    expect(apps.map((reader) => reader.renders)).toEqual([0, 0])
    sync.changes([{ type: 'activity', activity: working('5', 2) }])
    await settled()
    expect([five.renders, six.renders]).toEqual([1, 0])
    expect(five.observer.getCurrentResult().data?.state).toBe('working')
    for (const reader of [...apps, five, six]) reader.stop()
  })
})
