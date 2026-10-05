import type { ConversationActivity, ConversationView } from '@purrable/contracts'
import { isClosed } from './threads.ts'

/** A conversation in the sidebar, with the open conversations under it and, folded away, the closed ones. */
export type TreeNode = {
  readonly view: ConversationView
  readonly children: readonly TreeNode[]
  readonly closed: readonly TreeNode[]
}

/**
 * The sidebar: main with the subagents under it (and everything under those), then the threads (each with everything
 * under it), then, folded, the threads that are closed. A thread anywhere sits under the conversation it branched from,
 * except a thread of main, which is in the Threads group.
 */
export type WorkspaceTree = {
  readonly main: TreeNode | undefined
  readonly threads: readonly TreeNode[]
  readonly closedThreads: readonly TreeNode[]
}

const newestFirst = (a: ConversationView, b: ConversationView) =>
  b.createdAt - a.createdAt || Number(b.id) - Number(a.id)

export function buildTree(views: readonly ConversationView[]): WorkspaceTree {
  const under = new Map<string, ConversationView[]>()
  for (const view of views.toSorted(newestFirst))
    if (view.parent !== undefined) under.set(view.parent, [...(under.get(view.parent) ?? []), view])
  // Each conversation once, however its parents point: a cycle in stored data ends instead of recursing forever.
  const seen = new Set<string>()
  const node = (view: ConversationView, keep: (child: ConversationView) => boolean = () => true): TreeNode => {
    seen.add(view.id)
    const below = (under.get(view.id) ?? [])
      .filter((child) => keep(child) && !seen.has(child.id))
      .map((child) => node(child))
    return {
      view,
      children: below.filter((child) => !isClosed(child.view)),
      closed: below.filter((child) => isClosed(child.view)),
    }
  }
  const main = views.find((view) => view.kind === 'main')
  const tree = main === undefined ? undefined : node(main, (child) => child.kind !== 'thread')
  const threads = (main === undefined ? [] : (under.get(main.id) ?? []))
    .filter((view) => view.kind === 'thread' && !seen.has(view.id))
    .map((view) => node(view))
  return {
    main: tree,
    threads: threads.filter((thread) => !isClosed(thread.view)),
    closedThreads: threads.filter((thread) => isClosed(thread.view)),
  }
}

/** Whether a conversation has replies the owner has not seen: any after its read mark, or any at all without one. */
export const isUnread = (view: ConversationView): boolean =>
  view.lastReplyAt !== undefined && view.lastReplyAt > (view.readAt ?? 0)

/** What a row shows: what its agent is doing (since when), whether work goes on below it, and unread replies. */
export type RowStatus = {
  readonly state: ConversationActivity['state']
  readonly since?: number
  readonly below: boolean
  readonly unread: boolean
}

type Activity = ReadonlyMap<string, ConversationActivity>

const busyBelow = (node: TreeNode, activity: Activity): boolean =>
  node.children.some((child) => activity.has(child.view.id) || busyBelow(child, activity))

export function rowStatus(node: TreeNode, activity: Activity): RowStatus {
  const own = activity.get(node.view.id)
  return {
    state: own?.state ?? 'idle',
    ...(own === undefined ? {} : { since: own.since }),
    below: busyBelow(node, activity),
    unread: isUnread(node.view),
  }
}

/** Whether a row belongs on the folded rail: open in a pane, at work (or above work), or with unread replies. */
const active = (node: TreeNode, activity: Activity, open: (id: string) => boolean): boolean => {
  const status = rowStatus(node, activity)
  return open(node.view.id) || status.state !== 'idle' || status.below || status.unread
}

/**
 * The folded rail: main and the active conversations of its tree, then the active threads and theirs, each group in
 * tree order. A closed conversation is never on it.
 */
export function railItems(
  tree: WorkspaceTree,
  activity: Activity,
  open: (id: string) => boolean,
): { readonly main: readonly TreeNode[]; readonly threads: readonly TreeNode[] } {
  const walk = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.flatMap((node) => [...(active(node, activity, open) ? [node] : []), ...walk(node.children)])
  return {
    main: tree.main === undefined ? [] : [tree.main, ...walk(tree.main.children)],
    threads: walk(tree.threads),
  }
}

/** The names from main down to a conversation, for its hover card: "Main › Trip › Flights". */
export function pathOf(views: readonly ConversationView[], id: string, name: (view: ConversationView) => string) {
  const byId = new Map(views.map((view) => [view.id, view]))
  const names: string[] = []
  const seen = new Set<string>()
  for (let view = byId.get(id); view !== undefined && !seen.has(view.id); view = byId.get(view.parent ?? '')) {
    seen.add(view.id)
    names.unshift(name(view))
  }
  return names
}
