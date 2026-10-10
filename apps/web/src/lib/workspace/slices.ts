import type {
  AppView,
  ConversationActivity,
  ConversationView,
  OrganizeReceipt,
  PersonaInvocationView,
  PersonaView,
  TopicView,
  WorkspaceChange,
  WorkspaceSnapshot,
} from '@goblin/contracts'

/**
 * What each conversation that is not idle is doing, by its id. A plain record, not a Map: Query keeps the entries that
 * did not change, so a reader of one conversation's activity sees nothing move when another's does.
 */
export type Activity = Readonly<Record<string, ConversationActivity>>

/**
 * The workspace as the feed tells it, one slice each, each kept in the Query cache under `['workspace', slice]`: the
 * owner's conversations, oldest first; what each one that is not idle is doing; their kept Apps, oldest first; the
 * Topics and Personas; the Persona answers still on their way (and the newest settled ones); and the latest organizing
 * receipts, newest first.
 */
export type Slices = {
  readonly conversations: readonly ConversationView[]
  readonly activity: Activity
  readonly apps: readonly AppView[]
  readonly topics: readonly TopicView[]
  readonly personas: readonly PersonaView[]
  readonly invocations: readonly PersonaInvocationView[]
  readonly receipts: readonly OrganizeReceipt[]
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
]

export const EMPTY_WORKSPACE: Slices = {
  conversations: [],
  activity: {},
  apps: [],
  topics: [],
  personas: [],
  invocations: [],
  receipts: [],
}

/** How many settled Persona answers and organizing receipts the slices keep: enough for Activity and Tasks. */
const KEPT = 50

const oldestFirst = (a: ConversationView, b: ConversationView) =>
  a.createdAt - b.createdAt || Number(a.id) - Number(b.id)
const byId = (a: AppView, b: AppView) => Number(a.id) - Number(b.id)
const byNumber = (a: { readonly id: number }, b: { readonly id: number }) => a.id - b.id
const newestReceipt = (a: OrganizeReceipt, b: OrganizeReceipt) => b.at - a.at
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
})

/**
 * The workspace after `changes`, in order: a conversation, App, Topic, Persona, invocation or receipt replaces the one
 * with its id (a new one joins in its slice's order), a removed App goes, and an activity replaces what its
 * conversation was doing (idle drops it). A slice no change touched is the same value.
 */
export const applyChanges = (slices: Slices, changes: readonly WorkspaceChange[]): Slices => ({
  conversations: sliceAfter('conversations', slices.conversations, changes),
  activity: sliceAfter('activity', slices.activity, changes),
  apps: sliceAfter('apps', slices.apps, changes),
  topics: sliceAfter('topics', slices.topics, changes),
  personas: sliceAfter('personas', slices.personas, changes),
  invocations: sliceAfter('invocations', slices.invocations, changes),
  receipts: sliceAfter('receipts', slices.receipts, changes),
})

/** `apps` with each App the owner just changed shown as that call will leave it, the latest last. */
export const withPendingApps = (apps: readonly AppView[], pending: readonly AppView[]): readonly AppView[] =>
  pending.reduce((shown, app) => upsertBy(shown, app, same, byId), apps)
