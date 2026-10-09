import {
  type ConversationActivity,
  type ConversationView,
  PERSONAL_TOPIC,
  PRIMARY_CHAT,
  type TopicView,
} from '@goblin/contracts'
import { isClosed, isUnread } from './threads.ts'

/** Personal as a server without Topics implies it: the one Topic, whose Conversation is Main (`/c/1`). */
export const PERSONAL: TopicView = {
  id: PERSONAL_TOPIC,
  name: 'Personal',
  conversation: PRIMARY_CHAT,
  personal: true,
  searchExcluded: false,
  revision: 0,
  createdBy: 'system',
  createdAt: 0,
}

/** The owner's Topics as the server lists them, or Personal alone from a server that lists none. */
export const topicsOf = (topics: readonly TopicView[] | undefined): readonly TopicView[] =>
  topics === undefined || topics.length === 0 ? [PERSONAL] : topics

export const isArchived = (topic: TopicView): boolean => topic.archivedAt !== undefined

const byName = (a: TopicView, b: TopicView) =>
  Number(b.personal === true) - Number(a.personal === true) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  a.id - b.id

/** The sidebar's channels: the active Topics, Personal first and then by name, and apart from them the archived ones. */
export function channels(topics: readonly TopicView[] | undefined): {
  readonly active: readonly TopicView[]
  readonly archived: readonly TopicView[]
} {
  const all = topicsOf(topics).toSorted(byName)
  return { active: all.filter((topic) => !isArchived(topic)), archived: all.filter(isArchived) }
}

/** Whether a chat is a Topic's one Conversation (its channel) rather than a thread or a subagent. */
export const isChannel = (view: ConversationView): boolean => view.conversation === true || view.kind === 'main'

/**
 * The channel a chat belongs to: itself when it is one, else its Topic's Conversation, else the nearest channel above
 * it, else Personal's. Stored parents that loop end the walk instead of looping.
 */
export function channelOf(
  id: string,
  views: readonly ConversationView[],
  topics: readonly TopicView[] | undefined,
): string {
  const byId = new Map(views.map((view) => [view.id, view]))
  const seen = new Set<string>()
  for (let view = byId.get(id); view !== undefined && !seen.has(view.id); view = byId.get(view.parent ?? '')) {
    if (isChannel(view)) return view.id
    const topic = view.topic === undefined ? undefined : topicsOf(topics).find(({ id: each }) => each === view.topic)
    if (topic !== undefined) return topic.conversation
    seen.add(view.id)
  }
  return PRIMARY_CHAT
}

/** The Topic whose Conversation `channel` is; Personal for Main on a server without Topics. */
export const topicOfChannel = (channel: string, topics: readonly TopicView[] | undefined): TopicView | undefined =>
  topicsOf(topics).find((topic) => topic.conversation === channel)

/** How many of a Topic's threads the sidebar lists under it. */
const LISTED = 5
const latest = (view: ConversationView) => view.lastReplyAt ?? view.createdAt

/**
 * The threads the sidebar lists under a Topic's channel, one flat level: those at work, with unread replies, recently
 * opened here, or showing now, newest first. A closed one is not listed; the Threads page has every one.
 */
export function topicThreads(
  channel: string,
  views: readonly ConversationView[],
  topics: readonly TopicView[] | undefined,
  activity: ReadonlyMap<string, ConversationActivity>,
  recent: ReadonlySet<string>,
): ConversationView[] {
  return views
    .filter(
      (view) =>
        !isChannel(view) &&
        !isClosed(view) &&
        (activity.has(view.id) || isUnread(view) || recent.has(view.id)) &&
        channelOf(view.id, views, topics) === channel,
    )
    .toSorted((a, b) => latest(b) - latest(a) || Number(b.id) - Number(a.id))
    .slice(0, LISTED)
}
