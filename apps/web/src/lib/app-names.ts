import type { AppView } from '@goblin/contracts'

const byCreation = (a: AppView, b: AppView) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/**
 * Every App's name: its title, and where its conversation has kept several by that title (one tool called again and
 * again), its number among them in order of creation, closed ones counted, so the names do not shift.
 */
export function appNames(apps: readonly AppView[]): ReadonlyMap<string, string> {
  const named = new Map<string, AppView[]>()
  for (const app of apps.toSorted(byCreation)) {
    const key = `${app.conversation}\u0000${app.title}`
    named.set(key, [...(named.get(key) ?? []), app])
  }
  const names = new Map<string, string>()
  for (const same of named.values())
    for (const [index, app] of same.entries())
      names.set(app.id, same.length === 1 ? app.title : `${app.title} (${index + 1})`)
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
