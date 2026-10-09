import type {
  AppView,
  Attention,
  ConversationActivity,
  ConversationView,
  PersonaInvocationView,
} from '@goblin/contracts'
import { jobTrouble } from './app-jobs.ts'
import { isClosed, isUnread } from './threads.ts'
import { isChannel } from './topics.ts'
import { answering } from './workspace-feed.ts'

type Activity = ReadonlyMap<string, ConversationActivity>

const latest = (view: ConversationView) => view.lastReplyAt ?? view.createdAt
const newest = (a: ConversationView, b: ConversationView) => latest(b) - latest(a) || Number(b.id) - Number(a.id)

/** The Threads page: the open threads with unread replies first, then the rest, newest first; the closed apart. */
export function threadList(views: readonly ConversationView[]): {
  readonly unread: readonly ConversationView[]
  readonly read: readonly ConversationView[]
  readonly closed: readonly ConversationView[]
} {
  const threads = views.filter((view) => view.kind === 'thread' && !isChannel(view)).toSorted(newest)
  const open = threads.filter((view) => !isClosed(view))
  return {
    unread: open.filter(isUnread),
    read: open.filter((view) => !isUnread(view)),
    closed: threads.filter(isClosed),
  }
}

/** One thing that waits for the owner, as Activity lists it: in a chat (a question, an approval…) or an App. */
export type NeedsYou =
  | { readonly kind: 'chat'; readonly chat: ConversationView; readonly attention: Attention }
  | { readonly kind: 'app'; readonly app: AppView }

/**
 * What waits for the owner: every chat's attention (from a server that reports it), oldest first, then the agent apps
 * whose schedules are paused, failing or waiting for the owner.
 */
export function needsYou(views: readonly ConversationView[], apps: readonly AppView[]): readonly NeedsYou[] {
  const asks = views
    .filter((view) => !isClosed(view))
    .flatMap((chat) => (chat.attention ?? []).map((attention) => ({ kind: 'chat' as const, chat, attention })))
    .toSorted((a, b) => a.attention.since - b.attention.since)
  const troubled = apps
    .filter((app) => app.closedAt === undefined && app.source.kind === 'agent' && app.source.jobs.some(jobTrouble))
    .map((app) => ({ kind: 'app' as const, app }))
  return [...asks, ...troubled]
}

/** The chats with replies the owner has not read, newest first: channels and threads alike. */
export const unreadChats = (views: readonly ConversationView[]): readonly ConversationView[] =>
  views.filter((view) => !isClosed(view) && view.kind !== 'subagent' && isUnread(view)).toSorted(newest)

/**
 * The Tasks page's Delegates (subagents): those at work first, then the others still open, newest first; the
 * finished ones (closed once their job was done, or by the owner) apart, the newest few.
 */
export function delegates(
  views: readonly ConversationView[],
  activity: Activity,
  finishedShown = 10,
): { readonly active: readonly ConversationView[]; readonly finished: readonly ConversationView[] } {
  const subagents = views.filter((view) => view.kind === 'subagent').toSorted(newest)
  const open = subagents.filter((view) => !isClosed(view))
  return {
    active: [...open.filter((view) => activity.has(view.id)), ...open.filter((view) => !activity.has(view.id))],
    finished: subagents.filter(isClosed).slice(0, finishedShown),
  }
}

/** Persona answers for Tasks: those on their way first (in order), then the settled ones, newest first. */
export const personaTasks = (invocations: readonly PersonaInvocationView[]): readonly PersonaInvocationView[] => [
  ...invocations.filter(answering).toSorted((a, b) => a.createdAt - b.createdAt || a.order - b.order),
  ...invocations.filter((each) => !answering(each)).toSorted((a, b) => b.createdAt - a.createdAt),
]

/** The rail's counts: unread threads, what needs the owner, and the work going on (Delegates and Personas). */
export function railCounts(
  views: readonly ConversationView[],
  apps: readonly AppView[],
  activity: Activity,
  invocations: readonly PersonaInvocationView[],
): { readonly threads: number; readonly activity: number; readonly tasks: number } {
  const working = views.filter((view) => view.kind === 'subagent' && activity.has(view.id)).length
  return {
    threads: threadList(views).unread.length,
    activity: needsYou(views, apps).length,
    tasks: working + invocations.filter(answering).length,
  }
}
