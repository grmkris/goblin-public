// The workspace feed's slices for components. Each hook reads one slice from the Query cache, through `select` where
// it needs less, so a component renders again only when what it selected changed: a conversation's change renders
// no App reader, and one conversation's activity renders only the readers of that conversation's. Until the feed's
// first snapshot is in, each answers as an empty workspace would.
import { useCallback } from 'react'
import { type QueryKey, type UseQueryOptions, useQuery } from '@tanstack/react-query'
import type {
  AppView,
  ConversationActivity,
  ConversationView,
  OrganizeReceipt,
  PersonaInvocationView,
  PersonaView,
  TopicView,
} from '@goblin/contracts'
import { type Activity, EMPTY_WORKSPACE, activityOf } from './slices.ts'
import { workspaceQueries } from './sync.ts'

const whole = <T>(value: T): T => value

/** A slice's read through `select`; before the first snapshot, `select` of the empty slice. */
function useSlice<D, K extends QueryKey, T>(
  read: UseQueryOptions<D, Error, D, K>,
  empty: D,
  select: (value: D) => T,
): T {
  const query = useQuery({ ...read, select })
  return query.status === 'success' ? query.data : select(empty)
}

/** The owner's conversations, oldest first, or what `select` takes from them. */
export function useConversations(): readonly ConversationView[]
export function useConversations<T>(select: (conversations: readonly ConversationView[]) => T): T
export function useConversations<T>(select?: (conversations: readonly ConversationView[]) => T) {
  const pick: (conversations: readonly ConversationView[]) => T | readonly ConversationView[] = select ?? whole
  return useSlice(workspaceQueries.conversations, EMPTY_WORKSPACE.conversations, pick)
}

/** Conversation `id` as the feed shows it; undefined until it does (or with no id). */
export function useConversation(id: string | undefined): ConversationView | undefined {
  return useConversations(
    useCallback((conversations: readonly ConversationView[]) => conversations.find((view) => view.id === id), [id]),
  )
}

/** What every conversation that is not idle is doing, or what `select` takes from that. */
export function useActivities(): Activity
export function useActivities<T>(select: (activity: Activity) => T): T
export function useActivities<T>(select?: (activity: Activity) => T) {
  const pick: (activity: Activity) => T | Activity = select ?? whole
  return useSlice(workspaceQueries.activity, EMPTY_WORKSPACE.activity, pick)
}

/** What conversation `id`'s agent is doing now; undefined while it is idle. */
export function useActivity(id: string): ConversationActivity | undefined {
  return useActivities(useCallback((activity: Activity) => activityOf(activity, id), [id]))
}

/** The kept Apps, oldest first, or what `select` takes from them. */
export function useApps(): readonly AppView[]
export function useApps<T>(select: (apps: readonly AppView[]) => T): T
export function useApps<T>(select?: (apps: readonly AppView[]) => T) {
  const pick: (apps: readonly AppView[]) => T | readonly AppView[] = select ?? whole
  return useSlice(workspaceQueries.apps, EMPTY_WORKSPACE.apps, pick)
}

/** The Topics, in order. */
export const useTopics = (): readonly TopicView[] => useSlice(workspaceQueries.topics, EMPTY_WORKSPACE.topics, whole)

/** The Personas, in order. */
export const usePersonas = (): readonly PersonaView[] =>
  useSlice(workspaceQueries.personas, EMPTY_WORKSPACE.personas, whole)

/** The Persona answers on their way, and the newest settled ones. */
export const useInvocations = (): readonly PersonaInvocationView[] =>
  useSlice(workspaceQueries.invocations, EMPTY_WORKSPACE.invocations, whole)

/** The latest organizing receipts, newest first. */
export const useReceipts = (): readonly OrganizeReceipt[] =>
  useSlice(workspaceQueries.receipts, EMPTY_WORKSPACE.receipts, whole)

/** What is wrong with the feed, or with the owner's last change to it, in words; empty when nothing is. */
export function useFeedStatus(): string {
  const query = useQuery(workspaceQueries.status)
  return query.data ?? ''
}
