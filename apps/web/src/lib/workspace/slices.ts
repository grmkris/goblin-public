import type {
  AppView,
  ConversationActivity,
  ConversationView,
  DecisionProposal,
  NotificationView,
  OrganizeReceipt,
  PersonaInvocationView,
  PersonaView,
  SidebarPins,
  TopicView,
  WorkspaceChange,
  WorkspaceSnapshot,
} from '@goblin/contracts'
import { EMPTY_SIDEBAR } from '@goblin/contracts'

/**
 * What each conversation that is not idle is doing, by its id. A plain record, not a Map: Query keeps the entries that
 * did not change, so a reader of one conversation's activity sees nothing move when another's does.
 */
export type Activity = Readonly<Record<string, ConversationActivity>>

/**
 * The workspace as the feed tells it, one slice each, each kept in the Query cache under `['workspace', slice]`: the
 * owner's conversations, oldest first; what each one that is not idle is doing; their kept Apps, oldest first; the
 * Topics and Personas; the Persona answers still on their way (and the newest settled ones); the latest organizing
 * receipts, newest first; the decision proposals still open or confirmed, oldest first; and the newest
 * notifications, newest first.
 */
export type Slices = {
  readonly conversations: readonly ConversationView[]
  readonly activity: Activity
  readonly apps: readonly AppView[]
  readonly topics: readonly TopicView[]
  readonly personas: readonly PersonaView[]
  readonly invocations: readonly PersonaInvocationView[]
  readonly receipts: readonly OrganizeReceipt[]
  readonly proposals: readonly DecisionProposal[]
  readonly notifications: readonly NotificationView[]
  /** Each connection's tool list as the feed last named it (a digest), by connection id: a change means read it again. */
  readonly tools: Readonly<Record<string, string>>
  /** The owner's pinned servers and App views (ADR 0053). */
  readonly sidebar: SidebarPins
}
export type Slice = keyof Slices

export const SLICE_NAMES: readonly Slice[] = [
  'conversations',
  'activity',
  'apps',
  'topics',
  'personas',
  'invocations',
  'receipts',
  'proposals',
  'notifications',
  'tools',
  'sidebar',
]

export const EMPTY_WORKSPACE: Slices = {
  conversations: [],
  activity: {},
  apps: [],
  topics: [],
  personas: [],
  invocations: [],
  receipts: [],
  proposals: [],
  notifications: [],
  tools: {},
  sidebar: EMPTY_SIDEBAR,
}

/** How many settled Persona answers and organizing receipts the slices keep: enough for Activity and Tasks. */
const KEPT = 50
/** How many notifications the slice keeps: as many as the server's snapshot sends. */
const KEPT_NOTIFICATIONS = 100

const oldestFirst = (a: ConversationView, b: ConversationView) =>
  a.createdAt - b.createdAt || Number(a.id) - Number(b.id)
const byId = (a: AppView, b: AppView) => Number(a.id) - Number(b.id)
const byNumber = (a: { readonly id: number }, b: { readonly id: number }) => a.id - b.id
const newestReceipt = (a: OrganizeReceipt, b: OrganizeReceipt) => b.at - a.at
const newestNotification = (a: NotificationView, b: NotificationView) => b.at - a.at || b.id.localeCompare(a.id)
const byOrder = (a: PersonaInvocationView, b: PersonaInvocationView) => a.order - b.order
const same = <T extends { readonly id: unknown }>(a: T, b: T) => a.id === b.id
const sameInvocation = (a: PersonaInvocationView, b: PersonaInvocationView) =>
  a.operationId === b.operationId && a.persona === b.persona

/** `items` with `item` in place of the one `same` matches, or added, in `order`. */
function upsertBy<T>(items: readonly T[], item: T, match: (a: T, b: T) => boolean, order: (a: T, b: T) => number) {
  const index = items.findIndex((each) => match(each, item))
  return index === -1 ? [...items, item].toSorted(order) : items.with(index, item)
}

/** Whether an invocation is still on its way: pending, or a Persona answering now. */
export const answering = (invocation: PersonaInvocationView): boolean =>
  invocation.state === 'pending' || invocation.state === 'running'

/** The invocations kept: every one still on its way, and the newest settled ones. */
const keptInvocations = (invocations: readonly PersonaInvocationView[]) => {
  const settled = invocations.filter((each) => !answering(each))
  const dropped = new Set(settled.toSorted((a, b) => b.createdAt - a.createdAt).slice(KEPT))
  return dropped.size === 0 ? invocations : invocations.filter((each) => !dropped.has(each))
}

/** A proposal the slice keeps: open, or confirmed (as the server's snapshot keeps it); dismissed and stale ones go. */
const kept = (proposal: DecisionProposal) => proposal.state === 'open' || proposal.state === 'confirmed'
const oldestProposal = (a: DecisionProposal, b: DecisionProposal) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id)

/** `proposals` with `proposal` as it is now: in place of the one with its id, or added; gone once settled away. */
function withProposal(proposals: readonly DecisionProposal[], proposal: DecisionProposal) {
  const others = proposals.filter((each) => each.id !== proposal.id)
  return kept(proposal) ? [...others, proposal].toSorted(oldestProposal) : others
}

/** What conversation `id` is doing now; undefined while it is idle. */
export const activityOf = (activity: Activity, id: string): ConversationActivity | undefined =>
  Object.hasOwn(activity, id) ? activity[id] : undefined

/** `activity` after one conversation's change: idle drops it, anything else replaces what it was doing. */
function withActivity(activity: Activity, change: ConversationActivity): Activity {
  if (change.state !== 'idle') return { ...activity, [change.id]: change }
  if (!Object.hasOwn(activity, change.id)) return activity
  const { [change.id]: _dropped, ...rest } = activity
  return rest
}

/** A slice: empty, read from a snapshot, and after one change (itself, untouched, after a change of another kind). */
type SliceOf<T> = {
  readonly read: (snapshot: WorkspaceSnapshot) => T
  readonly apply: (value: T, change: WorkspaceChange) => T
}

/** Home changes are read by their own view; every other change kind belongs to exactly one slice. */
const SLICES: { readonly [K in Slice]: SliceOf<Slices[K]> } = {
  conversations: {
    read: (snapshot) => snapshot.conversations.toSorted(oldestFirst),
    apply: (value, change) =>
      change.type === 'conversation' ? upsertBy(value, change.conversation, same, oldestFirst) : value,
  },
  activity: {
    read: (snapshot) =>
      Object.fromEntries(snapshot.activity.filter(({ state }) => state !== 'idle').map((each) => [each.id, each])),
    apply: (value, change) => (change.type === 'activity' ? withActivity(value, change.activity) : value),
  },
  apps: {
    read: (snapshot) => snapshot.apps.toSorted(byId),
    apply: (value, change) => {
      if (change.type === 'app') return upsertBy(value, change.app, same, byId)
      return change.type === 'app-removed' ? value.filter((app) => app.id !== change.id) : value
    },
  },
  topics: {
    read: (snapshot) => (snapshot.topics ?? []).toSorted(byNumber),
    apply: (value, change) => (change.type === 'topic' ? upsertBy(value, change.topic, same, byNumber) : value),
  },
  personas: {
    read: (snapshot) => (snapshot.personas ?? []).toSorted(byNumber),
    apply: (value, change) => (change.type === 'persona' ? upsertBy(value, change.persona, same, byNumber) : value),
  },
  invocations: {
    read: (snapshot) => snapshot.invocations ?? [],
    apply: (value, change) =>
      change.type === 'invocation'
        ? keptInvocations(upsertBy(value, change.invocation, sameInvocation, byOrder))
        : value,
  },
  receipts: {
    read: (snapshot) => (snapshot.receipts ?? []).toSorted(newestReceipt).slice(0, KEPT),
    apply: (value, change) =>
      change.type === 'receipt' ? upsertBy(value, change.receipt, same, newestReceipt).slice(0, KEPT) : value,
  },
  proposals: {
    read: (snapshot) => (snapshot.proposals ?? []).filter(kept).toSorted(oldestProposal),
    apply: (value, change) => (change.type === 'proposal' ? withProposal(value, change.proposal) : value),
  },
  notifications: {
    read: (snapshot) => (snapshot.notifications ?? []).toSorted(newestNotification).slice(0, KEPT_NOTIFICATIONS),
    apply: (value, change) =>
      change.type === 'notification'
        ? upsertBy(value, change.notification, same, newestNotification).slice(0, KEPT_NOTIFICATIONS)
        : value,
  },
  tools: {
    // The snapshot names no lists: a connection's first change after it is a change all the same.
    read: () => ({}),
    apply: (value, change) =>
      change.type === 'tools' && value[change.connectionId] !== change.digest
        ? { ...value, [change.connectionId]: change.digest }
        : value,
  },
  sidebar: {
    read: (snapshot) => snapshot.sidebar ?? EMPTY_SIDEBAR,
    // An answer the owner's edit showed first is newer than the feed's repeat of an older revision.
    apply: (value, change) =>
      change.type === 'sidebar' && change.sidebar.revision >= value.revision ? change.sidebar : value,
  },
}

/** Slice `slice` as the snapshot describes it. */
const sliceOf = <K extends Slice>(slice: K, snapshot: WorkspaceSnapshot): Slices[K] => SLICES[slice].read(snapshot)

/** Slice `slice` after `changes`, in order; the same value when none of them is its kind. */
const sliceAfter = <K extends Slice>(slice: K, value: Slices[K], changes: readonly WorkspaceChange[]) =>
  changes.reduce((current, change) => SLICES[slice].apply(current, change), value)

/** The workspace as the feed's snapshot describes it. */
export const fromSnapshot = (snapshot: WorkspaceSnapshot): Slices => ({
  conversations: sliceOf('conversations', snapshot),
  activity: sliceOf('activity', snapshot),
  apps: sliceOf('apps', snapshot),
  topics: sliceOf('topics', snapshot),
  personas: sliceOf('personas', snapshot),
  invocations: sliceOf('invocations', snapshot),
  receipts: sliceOf('receipts', snapshot),
  proposals: sliceOf('proposals', snapshot),
  notifications: sliceOf('notifications', snapshot),
  tools: sliceOf('tools', snapshot),
  sidebar: sliceOf('sidebar', snapshot),
})

/**
 * The workspace after `changes`, in order: a conversation, App, Topic, Persona, invocation, receipt, proposal or
 * notification replaces the one with its id (a new one joins in its slice's order; a dismissed or stale proposal goes), a removed
 * App goes, and an activity replaces what its conversation was doing (idle drops it). A slice no change touched is the
 * same value.
 */
export const applyChanges = (slices: Slices, changes: readonly WorkspaceChange[]): Slices => ({
  conversations: sliceAfter('conversations', slices.conversations, changes),
  activity: sliceAfter('activity', slices.activity, changes),
  apps: sliceAfter('apps', slices.apps, changes),
  topics: sliceAfter('topics', slices.topics, changes),
  personas: sliceAfter('personas', slices.personas, changes),
  invocations: sliceAfter('invocations', slices.invocations, changes),
  receipts: sliceAfter('receipts', slices.receipts, changes),
  proposals: sliceAfter('proposals', slices.proposals, changes),
  notifications: sliceAfter('notifications', slices.notifications, changes),
  tools: sliceAfter('tools', slices.tools, changes),
  sidebar: sliceAfter('sidebar', slices.sidebar, changes),
})

/** `apps` with each App the owner just changed shown as that call will leave it, the latest last. */
export const withPendingApps = (apps: readonly AppView[], pending: readonly AppView[]): readonly AppView[] =>
  pending.reduce((shown, app) => upsertBy(shown, app, same, byId), apps)
