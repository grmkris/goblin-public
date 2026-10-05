import type { ThreadView } from '@purrable/contracts'
import { isString, record } from './boundary.ts'
import type { Part, ToolPart } from './parts.ts'

/** A conversation with the subagents it started, newest first. */
export type ThreadNode = { readonly thread: ThreadView; readonly subagents: readonly ThreadView[] }
/** The list the owner sees: main, then live threads newest first (each with its subagents), then archived ones. */
export type ThreadTree = {
  readonly main: ThreadNode | undefined
  readonly threads: readonly ThreadNode[]
  readonly archived: readonly ThreadView[]
}

const newestFirst = (a: ThreadView, b: ThreadView) => b.createdAt - a.createdAt || Number(b.id) - Number(a.id)

/** Arranges the registry for the thread list. A subagent sits under the conversation that started it. */
export function threadTree(views: readonly ThreadView[]): ThreadTree {
  const live = views.filter((view) => !view.archived)
  const node = (thread: ThreadView): ThreadNode => ({
    thread,
    subagents: live.filter((view) => view.kind === 'subagent' && view.parent === thread.id).toSorted(newestFirst),
  })
  const main = views.find((view) => view.kind === 'main')
  return {
    main: main === undefined ? undefined : node(main),
    threads: live
      .filter((view) => view.kind === 'thread')
      .toSorted(newestFirst)
      .map(node),
    archived: views.filter((view) => view.archived).toSorted(newestFirst),
  }
}

/** What to call a conversation: main is Main; a thread or subagent has its title, or a placeholder until it gets one. */
export function threadTitle(view: ThreadView | undefined): string {
  if (view === undefined || view.kind === 'main') return 'Main'
  return view.title ?? (view.kind === 'subagent' ? 'Subagent' : 'New thread')
}

/** The live threads branched from each message of main (by entry id), newest first: what the reply rows show. */
export function threadsByFork(views: readonly ThreadView[]): ReadonlyMap<number, readonly ThreadView[]> {
  const byFork = new Map<number, ThreadView[]>()
  for (const view of views
    .filter((candidate) => candidate.kind === 'thread' && !candidate.archived)
    .toSorted(newestFirst))
    if (view.forkEntry !== undefined) byFork.set(view.forkEntry, [...(byFork.get(view.forkEntry) ?? []), view])
  return byFork
}

/** The entries a thread can branch from: what the owner or the agent said (Pi's `pi.user` and `pi.assistant`). */
export function branchPoints(entries: readonly Record<string, unknown>[]): ReadonlySet<number> {
  return new Set(
    entries.flatMap((entry) =>
      (entry.kind === 'pi.user' || entry.kind === 'pi.assistant') && typeof entry.id === 'number' ? [entry.id] : [],
    ),
  )
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
/** Each unit and how many seconds it takes before the next one reads better. */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number, number])[] = [
  ['minute', 60, 45 * 60],
  ['hour', 3600, 22 * 3600],
  ['day', 86_400, 6 * 86_400],
  ['week', 7 * 86_400, 4 * 7 * 86_400],
  ['month', 30 * 86_400, 11 * 30 * 86_400],
]

/** How long ago `at` was, as people say it: "just now", "2 minutes ago", "yesterday", "3 weeks ago" (both in seconds). */
export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at)
  if (ago < 45) return 'just now'
  const unit = UNITS.find(([, , below]) => ago < below)
  if (unit === undefined) return RELATIVE.format(-Math.round(ago / (365 * 86_400)), 'year')
  return RELATIVE.format(-Math.max(1, Math.round(ago / unit[1])), unit[0])
}

/** "3 replies", "1 reply", "No replies yet". */
export function repliesLabel(count: number): string {
  if (count === 0) return 'No replies yet'
  return count === 1 ? '1 reply' : `${count} replies`
}

/** The Pi entry a transcript part belongs to (part ids start with the entry id), for branching from it. */
export function entryOfPart(id: string): number | undefined {
  const entry = Number(id.split(':')[0])
  return Number.isSafeInteger(entry) && entry > 0 ? entry : undefined
}

/**
 * A branched thread as its panel shows it: the message it branched from (entry `floor`), then what was said in the
 * thread itself, without the main history before it. Message ids start with their entry id.
 */
export function fromEntry<M extends { readonly id: string }>(messages: readonly M[], floor: number): M[] {
  return messages.filter((message) => (entryOfPart(message.id) ?? 0) >= floor)
}

/** What a thread's panel shows of the message it starts from: its words (its thoughts and tool calls stay in main). */
export function rootParts(parts: readonly Part[], entry: number): Part[] {
  return parts.filter((part) => (part.kind === 'text' || part.kind === 'user') && entryOfPart(part.id) === entry)
}

/** The subagent a `subagent` call started or addressed, from the details of its result. */
export function subagentOf(part: ToolPart): { readonly name: string; readonly thread: string } | undefined {
  const details = record(part.result?.details)
  if (part.call.name !== 'subagent' || details === undefined) return undefined
  const { name, conversationId } = details
  return isString(name) && typeof conversationId === 'number' ? { name, thread: String(conversationId) } : undefined
}
