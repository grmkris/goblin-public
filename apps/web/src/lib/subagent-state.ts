import type { ConversationActivity, ConversationView } from '@goblin/contracts'
import { isClosed, relativeTime } from './threads.ts'

/**
 * Where a subagent is in its life, from the workspace feed: at work (since, in ms), waiting on its own subagents,
 * done and reported (its last reply, in seconds), idle with nothing to show yet, stopped by the owner a moment ago (the
 * feed does not keep that, so the page says it until the subagent works again), or closed, by the owner or after its
 * report.
 */
export type SubagentState =
  | { readonly kind: 'working'; readonly since: number }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'reported'; readonly at: number }
  | { readonly kind: 'idle' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'closed'; readonly by: 'done' | 'owner' }

export function subagentState(
  view: ConversationView,
  activity: ConversationActivity | undefined,
  stopped = false,
): SubagentState {
  if (isClosed(view)) return { kind: 'closed', by: view.closedBy === 'done' ? 'done' : 'owner' }
  if (activity?.state === 'working') return { kind: 'working', since: activity.since }
  if (activity?.state === 'waiting') return { kind: 'waiting' }
  if (stopped) return { kind: 'stopped' }
  return view.lastReplyAt === undefined ? { kind: 'idle' } : { kind: 'reported', at: view.lastReplyAt }
}

/** Whether a subagent is doing anything Stop would end. */
export const isBusy = (state: SubagentState, below: number): boolean =>
  state.kind === 'working' || state.kind === 'waiting' || below > 0

/** How many subagents under `id`, at any depth, are at work or waiting on their own. */
export function workingUnder(
  id: string,
  conversations: readonly ConversationView[],
  activity: ReadonlyMap<string, ConversationActivity>,
): number {
  const seen = new Set([id])
  let count = 0
  let level = [id]
  while (level.length > 0) {
    const parents = new Set(level)
    const next = conversations.filter(
      (view) => view.kind === 'subagent' && view.parent !== undefined && parents.has(view.parent) && !seen.has(view.id),
    )
    for (const view of next) {
      seen.add(view.id)
      if (activity.has(view.id)) count += 1
    }
    level = next.map((view) => view.id)
  }
  return count
}

/** A subagent's state in words, as its row and pill show it beside any timer; `now` and report times in seconds. */
export function subagentLabel(state: SubagentState, now: number): string {
  switch (state.kind) {
    case 'working':
      return 'working'
    case 'waiting':
      return 'waiting on its subagents'
    case 'reported':
      return `reported ${relativeTime(state.at, now)}`
    case 'idle':
      return 'idle'
    case 'stopped':
      return 'stopped by you'
    case 'closed':
      return state.by === 'done' ? 'closed after its report' : 'closed by you'
  }
}
