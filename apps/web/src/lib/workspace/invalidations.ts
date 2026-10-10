import type { QueryKey } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import { usageQuery } from '../../agent/queries.ts'
import { agentAppQuery, agentAppsQuery } from '../../agent-apps/queries.ts'
import { capabilitiesQuery } from '../../capabilities/queries.ts'
import { conversationKeys } from '../../conversations/queries.ts'
import { personaKeys } from '../../personas/queries.ts'
import { type Activity, type Slice, type Slices, activityOf } from './slices.ts'

/** The slices as the cache holds them: undefined for one no snapshot or change has written yet. */
export type Cached = { readonly [K in Slice]: Slices[K] | undefined }

const working = (activity: Activity, id: string) => activityOf(activity, id)?.state === 'working'

/**
 * A run that started or ended in a conversation. Its end is when the turn's spend is recorded and retrieval's sources
 * are kept; either edge may change what the conversation lets its agent use.
 */
function runEdges(before: Activity, after: Activity): QueryKey[] {
  const keys: QueryKey[] = []
  let ended = false
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = working(before, id)
    if (was === working(after, id)) continue
    keys.push(capabilitiesQuery(id).queryKey)
    if (!was) continue
    ended = true
    keys.push(conversationKeys.sources(id))
  }
  return ended ? [...keys, usageQuery.queryKey] : keys
}

const agentName = (app: AppView | undefined) => (app?.source.kind === 'agent' ? app.source.name : undefined)

/** An agent app the feed showed new, changed or gone: its page, and the list that summarises it. */
function agentAppEdges(before: readonly AppView[], after: readonly AppView[]): QueryKey[] {
  if (before === after) return []
  const was = new Map(before.map((app) => [app.id, app]))
  const is = new Map(after.map((app) => [app.id, app]))
  const names = new Set<string>()
  for (const id of new Set([...was.keys(), ...is.keys()])) {
    const old = was.get(id)
    const now = is.get(id)
    const name = agentName(now) ?? agentName(old)
    if (old !== now && name !== undefined) names.add(name)
  }
  if (names.size === 0) return []
  return [agentAppsQuery.queryKey, ...[...names].map((name) => agentAppQuery(name).queryKey)]
}

/**
 * The one map from what the feed changed to the server reads that went stale with it. `before` is the cache as it was
 * (a slice not there yet changed nothing anyone read), `after` the cache now: Query keeps the values that did not
 * change, so a value that is not the same one changed.
 *
 * - A run's start or end: the conversation's switches; at its end also its sources and today's usage.
 * - An agent app new, changed or gone: the Apps list and that app's page.
 * - A Persona changed: the Persona reads, and what composers can tag.
 */
export function staleAfter(before: Cached, after: Slices): readonly QueryKey[] {
  return [
    ...(before.activity === undefined ? [] : runEdges(before.activity, after.activity)),
    ...(before.apps === undefined ? [] : agentAppEdges(before.apps, after.apps)),
    ...(before.personas === undefined || before.personas === after.personas
      ? []
      : [personaKeys.all, conversationKeys.composers]),
  ]
}
