import type { TaskGraph } from '@earendil-works/pi-durable'
import type { ConversationActivity, WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PubSub from 'effect/PubSub'
import * as RcRef from 'effect/RcRef'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { Apps } from '../apps/service.ts'
import { Chats, Conversations } from '../chats/service.ts'
import { Decisions } from '../decisions/service.ts'
import { Home } from '../home/service.ts'
import { type AppError, attempt, toAppError } from '../http/errors.ts'
import { reportAndRecover, reportFailure } from '../observability/report.ts'
import { Receipts } from '../organize/service.ts'
import { Notices } from '../notices/service.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { BACKGROUND } from '../pi/context.ts'
import { PiSessions } from '../pi/sessions.ts'
import { promiseWith } from '../runtime/boundary.ts'
import { Changes } from '../runtime/changes.ts'
import { Sidebar } from '../sidebar/service.ts'
import { Topics } from '../topics/service.ts'
import { type Busy, activityOf, moveActivity } from './feed.ts'
import { Workspace, type WorkspaceEvent } from './service.ts'

/** What the feed reads, each source's service as it is now. */
type Sources = {
  readonly chats: Chats['Service']
  readonly conversations: Conversations['Service']
  readonly apps: Apps['Service']
  readonly home: Home['Service']
  readonly topics: Topics['Service']
  readonly personas: Personas['Service']
  readonly invocations: Invocations['Service']
  readonly receipts: Receipts['Service']
  readonly decisions: Decisions['Service']
  readonly notices: Notices['Service']
  readonly sidebar: Sidebar['Service']
}

const sources = Effect.gen(function* () {
  return {
    chats: yield* Chats,
    conversations: yield* Conversations,
    apps: yield* Apps,
    home: yield* Home,
    topics: yield* Topics,
    personas: yield* Personas,
    invocations: yield* Invocations,
    receipts: yield* Receipts,
    decisions: yield* Decisions,
    notices: yield* Notices,
    sidebar: yield* Sidebar,
  } satisfies Sources
})

/** Reads each key, in order. */
const each = <K, A>(keys: readonly K[], read: (key: K) => Effect.Effect<A, AppError>) => Effect.forEach(keys, read)

/** Conversations a write changed, each as it is now; a Persona's fork is never reported on its own. */
const describe = ({ chats, conversations }: Sources, ids: readonly string[]) =>
  Effect.map(
    each(ids, (id) =>
      Effect.gen(function* () {
        if (yield* chats.isHidden(id)) return Option.none()
        return yield* conversations.view(id)
      }),
    ),
    (views): WorkspaceChange[] =>
      views.flatMap((view) => (Option.isNone(view) ? [] : [{ type: 'conversation', conversation: view.value }])),
  )

/** The owner's decisions, Home layout, sidebar pins and connections' tool lists, as `followTopics` follows the rest. */
const followOwnerState = (
  changes: Changes['Service'],
  read: Sources,
  follow: (where: string, changed: Effect.Effect<readonly WorkspaceChange[], AppError>) => Effect.Effect<void>,
) =>
  Effect.all([
    changes.on('decisions.changed', ({ ids }) =>
      follow(
        'workspace.decisions',
        each(ids, (id) =>
          Effect.map(read.decisions.view(id), (proposal): WorkspaceChange => ({ type: 'proposal', proposal })),
        ),
      ),
    ),
    changes.on('mcp.tools', ({ connectionId, digest }) =>
      follow('workspace.tools', Effect.succeed([{ type: 'tools', connectionId, digest }])),
    ),
    changes.on('home.changed', () =>
      follow(
        'workspace.home',
        Effect.map(read.home.layout, (home): WorkspaceChange[] => [{ type: 'home', home }]),
      ),
    ),
    changes.on('sidebar.changed', () =>
      follow(
        'workspace.sidebar',
        Effect.map(read.sidebar.read, (sidebar): WorkspaceChange[] => [{ type: 'sidebar', sidebar }]),
      ),
    ),
  ])

/**
 * Follows every change bus topic the feed shows: each handler reads what its payload names, as it is now, through
 * `follow`. Conversations are described in `scope` (a view reads Pi), starting at once on the writer's stack, so a
 * change is read as the write left it; every other source answers at once.
 */
const followTopics = (
  changes: Changes['Service'],
  read: Sources,
  follow: (where: string, changed: Effect.Effect<readonly WorkspaceChange[], AppError>) => Effect.Effect<void>,
  scope: Scope.Scope,
) =>
  Effect.all([
    changes.on('conversations.changed', ({ ids }) =>
      Effect.asVoid(
        Effect.forkIn(follow('workspace.conversations', describe(read, ids)), scope, { startImmediately: true }),
      ),
    ),
    changes.on('apps.changed', ({ ids }) =>
      follow(
        'workspace.apps',
        each(ids, (id) => Effect.map(read.apps.view(id), (app): WorkspaceChange => ({ type: 'app', app }))),
      ),
    ),
    changes.on('apps.removed', ({ id }) => follow('workspace.apps', Effect.succeed([{ type: 'app-removed', id }]))),
    changes.on('topics.changed', ({ ids }) =>
      follow(
        'workspace.topics',
        each(ids, (id) => Effect.map(read.topics.get(id), (topic): WorkspaceChange => ({ type: 'topic', topic }))),
      ),
    ),
    changes.on('personas.changed', ({ ids }) =>
      follow(
        'workspace.personas',
        each(ids, (id) =>
          Effect.map(read.personas.get(id), (persona): WorkspaceChange => ({ type: 'persona', persona })),
        ),
      ),
    ),
    changes.on('invocations.changed', ({ ids }) =>
      follow(
        'workspace.invocations',
        Effect.map(
          each(ids, ({ operationId, persona }) => read.invocations.get(operationId, persona)),
          (found): WorkspaceChange[] =>
            found.flatMap((invocation) =>
              Option.isNone(invocation) ? [] : [{ type: 'invocation', invocation: invocation.value }],
            ),
        ),
      ),
    ),
    changes.on('receipts.changed', ({ ids }) =>
      follow(
        'workspace.receipts',
        each(ids, (id) =>
          Effect.map(read.receipts.view(id), (receipt): WorkspaceChange => ({ type: 'receipt', receipt })),
        ),
      ),
    ),
    changes.on('notices.changed', ({ ids }) =>
      follow(
        'workspace.notices',
        Effect.map(
          each(ids, (id) => read.notices.view(id)),
          (found): WorkspaceChange[] =>
            found.flatMap((notification) =>
              notification === undefined ? [] : [{ type: 'notification', notification }],
            ),
        ),
      ),
    ),
    followOwnerState(changes, read, follow),
  ])

/**
 * Pi's task graph, watched while anyone holds it, and what each conversation is doing by it, kept in `activity`: the
 * first holder starts the watch (its first graph sets the activity without announcing it), the last one stops it and
 * forgets the activity. A failed start is retried by the next holder. Each later graph moves the activity, sends what
 * changed, and describes the conversations that went idle.
 */
const taskGraph = (
  read: Sources,
  activity: Map<string, ConversationActivity>,
  emit: (batch: readonly WorkspaceChange[]) => Effect.Effect<void>,
  context: Context.Context<never>,
) => {
  const apply = (graph: TaskGraph, announce: boolean) =>
    Effect.gen(function* () {
      const next = new Map<string, Busy>()
      for (const [session, state] of activityOf(graph)) {
        const chat = yield* read.chats.chatOf(session)
        if (Option.isSome(chat) && !(yield* read.chats.isHidden(chat.value))) next.set(chat.value, state)
      }
      const moved = moveActivity(activity, next, yield* Clock.currentTimeMillis)
      if (!announce) return
      yield* emit(moved.changes)
      yield* Effect.flatMap(describe(read, moved.settled), emit)
    })
  // Pi calls the watch back with each graph and awaits the Promise.
  const toPromise = promiseWith(context)
  return Effect.gen(function* () {
    const pi = yield* (yield* PiSessions).pi.pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    const watch = yield* Effect.acquireRelease(
      attempt(() => pi.watchTaskGraph(BACKGROUND)),
      (running) => attempt(() => running.stop()).pipe(reportAndRecover('workspace.unwatch', undefined)),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => activity.clear()))
    yield* apply(watch.value, false)
    watch.start((graph) => toPromise(apply(graph, true).pipe(reportAndRecover('workspace.activity', undefined))))
  })
}

/**
 * The workspace feed (`Workspace`): the change bus topics of every source it shows, read only while a stream is
 * open, into one `PubSub` each stream subscribes to before it reads its snapshot, so no change between the two is
 * lost. Pi's task graph is watched while any stream is open (`RcRef`).
 */
export const WorkspaceLive: Layer.Layer<
  Workspace,
  never,
  | Changes
  | PiSessions
  | Chats
  | Conversations
  | Apps
  | Home
  | Topics
  | Personas
  | Invocations
  | Receipts
  | Decisions
  | Notices
  | Sidebar
> = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const read = yield* sources
    const context = yield* Effect.context()
    const feed = yield* PubSub.unbounded<readonly WorkspaceChange[]>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(feed))
    const activity = new Map<string, ConversationActivity>()
    const open = { streams: 0 }
    const emit = (batch: readonly WorkspaceChange[]) =>
      batch.length === 0 ? Effect.void : Effect.asVoid(PubSub.publish(feed, batch))
    yield* followTopics(
      yield* Changes,
      read,
      (where, changed) =>
        Effect.suspend(() =>
          open.streams === 0 ? Effect.void : changed.pipe(Effect.flatMap(emit), reportAndRecover(where, undefined)),
        ),
      yield* Effect.scope,
    )
    const watch = yield* RcRef.make({ acquire: taskGraph(read, activity, emit, context) })
    const snapshot: Effect.Effect<WorkspaceSnapshot, AppError> = Effect.gen(function* () {
      return {
        primary: read.chats.primary,
        conversations: yield* read.conversations.list,
        activity: [...activity.values()],
        apps: yield* read.apps.list,
        home: yield* read.home.layout,
        topics: yield* read.topics.list,
        personas: yield* read.personas.list,
        invocations: yield* read.invocations.live,
        receipts: yield* read.receipts.list(),
        proposals: yield* read.decisions.list,
        notifications: yield* read.notices.views,
        sidebar: yield* read.sidebar.read,
      }
    })
    const stream: Stream.Stream<WorkspaceEvent, AppError> = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(feed)
        yield* Effect.acquireRelease(
          Effect.sync(() => void (open.streams += 1)),
          () => Effect.sync(() => void (open.streams -= 1)),
        )
        yield* RcRef.get(watch)
        const first: WorkspaceEvent = { event: 'snapshot', data: yield* snapshot }
        return Stream.concat(
          Stream.succeed(first),
          Stream.map(Stream.fromSubscription(subscription), (data): WorkspaceEvent => ({ event: 'change', data })),
        )
      }).pipe(reportFailure('workspace.open')),
    )
    return Workspace.of({ stream })
  }),
)
