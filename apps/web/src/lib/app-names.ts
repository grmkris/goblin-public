import type { AppView } from '@goblin/contracts'

const byCreation = (a: AppView, b: AppView) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/**
 * A tool's name as words: camel case, dashes and underscores split, a first word that names its server (it is in the
 * connection's id or label) dropped, in sentence case. `trivago-accommodation-radius-search` reads "Accommodation radius
 * search".
 */
function toolWords(tool: string, server: readonly string[]): string {
  const words = tool
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s_-]+/u)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
  const [first = '', ...rest] = words
  const text = (rest.length > 0 && server.includes(first) ? rest : words).join(' ')
  return text === '' ? tool : `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * An App's own name: its title, or for an MCP App whose server gave its tool no title (the title is the tool's name),
 * the owner's label of the connection and the tool in words: "trivago hotels · Accommodation radius search".
 */
function readable(app: AppView, label?: (connectionId: string) => string): string {
  if (app.source.kind !== 'mcp' || app.title !== app.source.tool) return app.title
  const { connectionId, tool } = app.source
  const owned = label?.(connectionId)
  const named = owned === undefined || owned === connectionId ? undefined : owned
  const server = [connectionId, named ?? ''].flatMap((text) => text.toLowerCase().split(/[\s_.-]+/u))
  const words = toolWords(tool, server)
  return named === undefined ? words : `${named} · ${words}`
}

/**
 * Every App's name: its readable title (`label` names a connection, as `useConnectionLabels` does), and where its
 * conversation has kept several by that name (one tool called again and again), its number among them in order of
 * creation, closed ones counted, so the names do not shift.
 */
export function appNames(
  apps: readonly AppView[],
  label?: (connectionId: string) => string,
): ReadonlyMap<string, string> {
  const named = new Map<string, { readonly app: AppView; readonly title: string }[]>()
  for (const app of apps.toSorted(byCreation)) {
    const title = readable(app, label)
    const key = `${app.conversation}\u0000${title}`
    named.set(key, [...(named.get(key) ?? []), { app, title }])
  }
  const names = new Map<string, string>()
  for (const same of named.values())
    for (const [index, { app, title }] of same.entries())
      names.set(app.id, same.length === 1 ? title : `${title} (${index + 1})`)
  return names
}

/** The owner's open agent apps, newest first: the sidebar lists them apart from any conversation (ADR 0021). */
export const agentApps = (apps: readonly AppView[]): AppView[] =>
  apps
    .filter((app) => app.source.kind === 'agent' && app.closedAt === undefined)
    .toSorted(byCreation)
    .toReversed()

/** Where an App comes from, as its tile and caption name it: an MCP App's server, or an agent app's own name. */
export const appOrigin = (app: AppView): string =>
  app.source.kind === 'mcp' ? app.source.connectionId : app.source.name

/**
 * A hue for an App's tile, the same every time for its server: tiles tell Apps apart at a glance, as app icons do.
 * FNV-1a over the server id, spread over the colour wheel.
 */
export function appHue(connectionId: string): number {
  let hash = 0x811c9dc5
  for (const char of connectionId) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193)
  return (hash >>> 0) % 360
}
