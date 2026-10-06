import type { AppView, ConversationActivity, ConversationView } from '@goblin/contracts'
import { isClosed } from './threads.ts'

/** An App as the sidebar shows it: the App, and its name there. */
export type AppRow = { readonly app: AppView; readonly name: string }

/** A conversation in the sidebar, with its open Apps (newest first), the open conversations under it and, folded, the closed ones. */
export type TreeNode = {
  readonly view: ConversationView
  readonly apps: readonly AppRow[]
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
  /** The open agent apps, newest first: they live with the agent, not under a conversation (ADR 0021). */
  readonly agentApps: readonly AppRow[]
}

const newestFirst = (a: ConversationView, b: ConversationView) =>
  b.createdAt - a.createdAt || Number(b.id) - Number(a.id)

/** `items` by the key `of` gives each, in their order; an item without one is left out. */
function groupBy<T>(items: readonly T[], of: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = of(item)
    if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

const byCreation = (a: AppView, b: AppView) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/**
 * Every App's name: its title, and where its conversation has kept several by that title (one tool called again and
 * again), its number among them in order of creation, closed ones counted, so the names do not shift.
 */
export function appNames(apps: readonly AppView[]): ReadonlyMap<string, string> {
  const named = groupBy(apps.toSorted(byCreation), (app) => `${app.conversation}\u0000${app.title}`)
  const names = new Map<string, string>()
  for (const same of named.values())
    for (const [index, app] of same.entries())
      names.set(app.id, same.length === 1 ? app.title : `${app.title} (${index + 1})`)
  return names
}

/** How many of a conversation's Apps its row shows before the older ones fold away. */
const SHOWN_APPS = 3

/** A conversation's Apps as its row shows them: every one open as a page, then the newest up to `keep`; the rest fold. */
export function foldApps(rows: readonly AppRow[], paged: (id: string) => boolean, keep = SHOWN_APPS) {
  const shown = new Set(rows.filter(({ app }) => paged(app.id)).map(({ app }) => app.id))
  for (const { app } of rows) if (shown.size < keep) shown.add(app.id)
  return {
    shown: rows.filter(({ app }) => shown.has(app.id)),
    folded: rows.filter(({ app }) => !shown.has(app.id)),
  }
}

/** Where an App comes from, as its tile and caption name it: an MCP App's server, or an agent app's own name. */
export const appOrigin = (app: AppView): string => (app.source.kind === 'mcp' ? app.source.serverId : app.source.name)

/** An App's caption under its name: the server it came from, or that the agent built it. */
export const appCaption = (app: AppView): string =>
  app.source.kind === 'mcp' ? `App from ${app.source.serverId}` : `Built by your agent · v${app.source.version}`

/**
 * A hue for an App's tile, the same every time for its server: tiles tell Apps apart at a glance, as app icons do.
 * FNV-1a over the server id, spread over the colour wheel.
 */
export function appHue(serverId: string): number {
  let hash = 0x811c9dc5
  for (const char of serverId) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193)
  return (hash >>> 0) % 360
}

/** The open agent apps, newest first, each by its title. */
const agentAppRows = (apps: readonly AppView[]): AppRow[] =>
  apps
    .filter((app) => app.source.kind === 'agent' && app.closedAt === undefined)
    .toSorted(byCreation)
    .toReversed()
    .map((app) => ({ app, name: app.title }))

/**
 * `shown` says which conversations are open in a pane: a thread nobody ever wrote in (a send that failed) has no row
 * unless it is.
 */
export function buildTree(
  views: readonly ConversationView[],
  apps: readonly AppView[] = [],
  shown: (id: string) => boolean = () => false,
): WorkspaceTree {
  const names = appNames(apps)
  // An agent app lives with the agent (its own sidebar group); only MCP Apps sit under their conversation.
  const appsOf = groupBy(apps.toSorted(byCreation).toReversed(), (app) =>
    app.closedAt === undefined && app.source.kind === 'mcp' ? app.conversation : undefined,
  )
  const listed = views.filter((view) => view.kind !== 'thread' || view.replies > 0 || shown(view.id))
  const under = groupBy(listed.toSorted(newestFirst), (view) => view.parent)
  // Each conversation once, however its parents point: a cycle in stored data ends instead of recursing forever.
  const seen = new Set<string>()
  const node = (view: ConversationView, keep: (child: ConversationView) => boolean = () => true): TreeNode => {
    seen.add(view.id)
    const below = (under.get(view.id) ?? [])
      .filter((child) => keep(child) && !seen.has(child.id))
      .map((child) => node(child))
    return {
      view,
      apps: (appsOf.get(view.id) ?? []).map((app) => ({ app, name: names.get(app.id) ?? app.title })),
      children: below.filter((child) => !isClosed(child.view)),
      closed: below.filter((child) => isClosed(child.view)),
    }
  }
  const main = listed.find((view) => view.kind === 'main')
  const tree = main === undefined ? undefined : node(main, (child) => child.kind !== 'thread')
  const threads = (main === undefined ? [] : (under.get(main.id) ?? []))
    .filter((view) => view.kind === 'thread' && !seen.has(view.id))
    .map((view) => node(view))
  return {
    main: tree,
    threads: threads.filter((thread) => !isClosed(thread.view)),
    closedThreads: threads.filter((thread) => isClosed(thread.view)),
    agentApps: agentAppRows(apps),
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

/** How many conversations under `node`, at any depth, are working or waiting on their own subagents. */
export const busyUnder = (node: TreeNode, activity: Activity): number =>
  node.children.reduce((sum, child) => sum + (activity.has(child.view.id) ? 1 : 0) + busyUnder(child, activity), 0)

const unreadUnder = (node: TreeNode): boolean =>
  node.children.some((child) => isUnread(child.view) || unreadUnder(child))

/**
 * A row's open children as the sidebar lists them: the ones to show, and the subagents that have settled, which fold
 * under "n idle" until asked for. Settled: not at work and nothing at work under it, its replies and theirs read, not
 * in a pane (`shown`) and not kept open by the owner. A subagent that needs a look never folds away.
 */
export function settle(
  node: TreeNode,
  activity: Activity,
  shown: (id: string) => boolean,
): { readonly live: readonly TreeNode[]; readonly idle: readonly TreeNode[] } {
  const idle = (child: TreeNode): boolean =>
    child.view.kind === 'subagent' &&
    !child.view.keepOpen &&
    !activity.has(child.view.id) &&
    busyUnder(child, activity) === 0 &&
    !isUnread(child.view) &&
    !unreadUnder(child) &&
    !shown(child.view.id)
  return { live: node.children.filter((child) => !idle(child)), idle: node.children.filter(idle) }
}

/** Whether a row belongs on the folded rail: open in a pane, at work (or above work), or with unread replies. */
const active = (node: TreeNode, activity: Activity, open: (id: string) => boolean): boolean => {
  const status = rowStatus(node, activity)
  return open(node.view.id) || status.state !== 'idle' || status.below || status.unread
}

/** Every open conversation from `nodes` down, in tree order. */
const everyNode = (nodes: readonly TreeNode[]): TreeNode[] =>
  nodes.flatMap((node) => [node, ...everyNode(node.children)])

/**
 * The folded rail: main and the active conversations of its tree, then the active threads and theirs, each group in
 * tree order, then the Apps open as pages. A closed conversation is never on it.
 */
export function railItems(
  tree: WorkspaceTree,
  activity: Activity,
  open: (id: string) => boolean,
  paged: (app: string) => boolean = () => false,
): {
  readonly main: readonly TreeNode[]
  readonly threads: readonly TreeNode[]
  readonly apps: readonly AppRow[]
} {
  const walk = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.flatMap((node) => [...(active(node, activity, open) ? [node] : []), ...walk(node.children)])
  const all = [...(tree.main === undefined ? [] : everyNode([tree.main])), ...everyNode(tree.threads)]
  return {
    main: tree.main === undefined ? [] : [tree.main, ...walk(tree.main.children)],
    threads: walk(tree.threads),
    apps: [...all.flatMap((node) => node.apps), ...tree.agentApps].filter(({ app }) => paged(app.id)),
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
