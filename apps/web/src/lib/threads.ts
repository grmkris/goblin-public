import type { ThreadView } from '@purrable/contracts'
import { isString, record } from './boundary.ts'
import type { ToolPart } from './parts.ts'

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

/** The subagent a `subagent` call started or addressed, from the details of its result. */
export function subagentOf(part: ToolPart): { readonly name: string; readonly thread: string } | undefined {
  const details = record(part.result?.details)
  if (part.call.name !== 'subagent' || details === undefined) return undefined
  const { name, conversationId } = details
  return isString(name) && typeof conversationId === 'number' ? { name, thread: String(conversationId) } : undefined
}
