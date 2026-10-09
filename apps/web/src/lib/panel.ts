import type { ConversationView } from '@goblin/contracts'
import { isChannel } from './topics.ts'

/**
 * What the thread panel beside a channel holds, bottom to top: threads (or subagents) opened one inside another, and
 * on top possibly a draft that becomes a thread when it is sent: a reply to a message (`reply`), or a new empty thread
 * from the channel (`new`). The top one shows; the ones under it are the back path.
 */
export type PanelItem =
  | { readonly kind: 'thread'; readonly id: string }
  | { readonly kind: 'reply'; readonly conversation: string; readonly entry: number }
  | { readonly kind: 'new' }

/**
 * The channel page's search: `thread` is the thread the panel shows, `stack` the threads under it (outermost first,
 * `-` between ids; derived from its parents when absent), `reply` a draft on top (`<conversation>-<entry>` or `new`).
 * Numbers stay numbers so the URL reads `?thread=12`, not `?thread=%2212%22`.
 */
export type PanelSearch = {
  readonly thread?: number
  readonly stack?: string
  readonly reply?: string
}

const DIGITS = /^\d{1,12}$/u
const asId = (value: unknown): string | undefined => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof text === 'string' && DIGITS.test(text) ? text : undefined
}

/** The search as the route takes it from the URL: anything that is not one of these shapes is dropped. */
export function parsePanelSearch(raw: Record<string, unknown>): PanelSearch {
  const thread = asId(raw.thread)
  const stack = typeof raw.stack === 'number' ? String(raw.stack) : typeof raw.stack === 'string' ? raw.stack : ''
  const stackIds = stack.split('-').filter((id) => DIGITS.test(id))
  const reply = typeof raw.reply === 'string' && (raw.reply === 'new' || /^\d{1,12}-\d{1,15}$/u.test(raw.reply))
  return {
    ...(thread !== undefined && { thread: Number(thread) }),
    ...(thread !== undefined && stackIds.length > 0 && { stack: stackIds.join('-') }),
    ...(reply && { reply: String(raw.reply) }),
  }
}

/** The threads between a channel and one of its threads, outermost first, ending with the thread itself. */
function chainOf(thread: string, channel: string, views: readonly ConversationView[]): string[] {
  const byId = new Map(views.map((view) => [view.id, view]))
  const chain: string[] = []
  for (
    let view = byId.get(thread);
    view !== undefined && !chain.includes(view.id);
    view = byId.get(view.parent ?? '')
  ) {
    if (view.id === channel || isChannel(view)) break
    chain.unshift(view.id)
  }
  return chain.length === 0 ? [thread] : chain
}

/** What the panel holds for a channel's search; empty when it is closed. */
export function panelItems(search: PanelSearch, channel: string, views: readonly ConversationView[]): PanelItem[] {
  const thread = search.thread === undefined ? undefined : String(search.thread)
  const under = search.stack?.split('-').filter((id) => id !== thread) ?? []
  const threads = thread === undefined ? [] : under.length > 0 ? [...under, thread] : chainOf(thread, channel, views)
  const items: PanelItem[] = threads.map((id) => ({ kind: 'thread', id }))
  if (search.reply === 'new') items.push({ kind: 'new' })
  else if (search.reply !== undefined) {
    const [conversation = '', entry = ''] = search.reply.split('-')
    items.push({ kind: 'reply', conversation, entry: Number(entry) })
  }
  return items
}

/** The search that shows `items` in the panel: the inverse of `panelItems` for a stack its parents would derive. */
export function panelSearch(items: readonly PanelItem[], channel: string, views: readonly ConversationView[]) {
  const threads = items.flatMap((item) => (item.kind === 'thread' ? [item.id] : []))
  const top = threads.at(-1)
  const draft = items.at(-1)
  const reply =
    draft?.kind === 'new' ? 'new' : draft?.kind === 'reply' ? `${draft.conversation}-${draft.entry}` : undefined
  const derived = top === undefined ? [] : chainOf(top, channel, views)
  const explicit = threads.length > 1 && threads.join('-') !== derived.join('-')
  const search: PanelSearch = {
    ...(top !== undefined && { thread: Number(top) }),
    ...(explicit && { stack: threads.slice(0, -1).join('-') }),
    ...(reply !== undefined && { reply }),
  }
  return search
}

/** Where a draft's thread starts from: the message it replies to, or (a new thread) nothing. */
export const draftFrom = (item: PanelItem) =>
  item.kind === 'reply' ? { conversation: item.conversation, entry: item.entry } : undefined
