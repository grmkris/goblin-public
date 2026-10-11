import {
  type PersonaSetup,
  type SetupCatalog,
  type SetupItem,
  type TopicSetup,
  holds,
  itemLabel,
  withItems,
  withoutItems,
} from '@goblin/contracts'

/**
 * A Topic's or a Persona's setup as the picker edits it (ADR 0040): each list category is everything the owner allows
 * or only the items chosen, over what the catalog says can be chosen now. Pure functions over the draft; the picker
 * shows them and the editor saves the result.
 */
export type Setup = TopicSetup | PersonaSetup
export type Category = 'mcpServers' | 'skills' | 'apps'

/** Whether `category` holds everything the owner allows, including what they allow later. */
export const holdsEverything = (setup: Setup, category: Category): boolean => setup[category] === 'all'

/**
 * `setup` with `category` holding only these: what the catalog offers now, so nothing vanishes until it is switched
 * off. A category that already lists its items stays as it is.
 */
export function onlyThese<S extends Setup>(setup: S, category: Category, catalog: SetupCatalog): S {
  if (setup[category] !== 'all') return setup
  switch (category) {
    case 'mcpServers':
      return {
        ...setup,
        mcpServers: catalog.servers.map(({ connectionId }) => ({ connectionId, tools: 'all' as const })),
      }
    case 'skills':
      return { ...setup, skills: catalog.libraries.map(({ connectionId }) => ({ connectionId })) }
    case 'apps':
      return { ...setup, apps: catalog.apps.map(({ name }) => name) }
  }
}

/** `setup` with `category` holding everything the owner allows. */
export const everything = <S extends Setup>(setup: S, category: Category): S => ({ ...setup, [category]: 'all' })

/** `setup` with `item` switched on or off; switching off part of what holds everything lists the rest. */
export const switched = <S extends Setup>(setup: S, item: SetupItem, on: boolean, catalog: SetupCatalog): S =>
  on ? withItems(setup, [item]) : withoutItems(setup, [item], catalog)

/** How much of a server the setup holds: all its tools, some of them, or none. */
export function serverHold(setup: Setup, server: SetupCatalog['servers'][number]): 'all' | 'some' | 'none' {
  if (!holds(setup, { kind: 'server', connectionId: server.connectionId })) return 'none'
  const held = server.tools.filter(({ name }) =>
    holds(setup, { kind: 'tool', connectionId: server.connectionId, name }),
  )
  return held.length === server.tools.length ? 'all' : 'some'
}

/** How much of a library the setup holds: the whole library, some of its skills, or none. */
export function libraryHold(setup: Setup, library: SetupCatalog['libraries'][number]): 'all' | 'some' | 'none' {
  if (setup.skills === 'all') return 'all'
  const entries = setup.skills.filter(({ connectionId }) => connectionId === library.connectionId)
  if (entries.length === 0) return 'none'
  return entries.some(({ name }) => name === undefined) ? 'all' : 'some'
}

/** Something a setup lists that cannot be chosen now, and why: it stays listed, never widens, and can be removed. */
export type Unavailable = { readonly item: SetupItem; readonly label: string; readonly reason: string }

const unavailable = (item: SetupItem, reason: string): Unavailable => ({ item, label: itemLabel(item), reason })

/** The servers and tools a setup lists that the catalog does not offer now. */
function serversGone(setup: Setup, catalog: SetupCatalog): readonly Unavailable[] {
  if (setup.mcpServers === 'all') return []
  const servers = new Map(catalog.servers.map((server) => [server.connectionId, server]))
  return setup.mcpServers.flatMap(({ connectionId, tools }) => {
    const server = servers.get(connectionId)
    if (server === undefined)
      return [unavailable({ kind: 'server', connectionId }, 'Not connected, or no tool granted')]
    if (tools === 'all') return []
    return tools
      .filter((name) => !server.tools.some((tool) => tool.name === name))
      .map((name) => unavailable({ kind: 'tool', connectionId, name }, 'Not granted any more'))
  })
}

/** The libraries and skills a setup lists that the catalog does not offer now (a skill only while its list reads). */
function skillsGone(setup: Setup, catalog: SetupCatalog): readonly Unavailable[] {
  if (setup.skills === 'all') return []
  const libraries = new Map(catalog.libraries.map((library) => [library.connectionId, library]))
  return setup.skills.flatMap(({ connectionId, name }) => {
    const library = libraries.get(connectionId)
    if (library === undefined) return [unavailable({ kind: 'library', connectionId }, 'Skills are off for this server')]
    const listed = name === undefined || !library.available || library.skills.some((skill) => skill.name === name)
    return listed ? [] : [unavailable({ kind: 'skill', connectionId, name }, 'No longer listed')]
  })
}

/** What `setup` lists that the catalog does not offer now (a server gone, a grant revoked, a skill renamed). */
export function unavailableIn(setup: Setup, catalog: SetupCatalog): readonly Unavailable[] {
  const apps = new Set(catalog.apps.map(({ name }) => name))
  const appsGone =
    setup.apps === 'all'
      ? []
      : setup.apps.filter((app) => !apps.has(app)).map((app) => unavailable({ kind: 'app', app }, 'No longer there'))
  return [...serversGone(setup, catalog), ...skillsGone(setup, catalog), ...appsGone]
}

/** How many of a category's items the setup holds now, or `all`. */
export function heldCount(setup: Setup, category: Category, catalog: SetupCatalog): number | 'all' {
  if (setup[category] === 'all') return 'all'
  switch (category) {
    case 'mcpServers':
      return catalog.servers.filter((server) => serverHold(setup, server) !== 'none').length
    case 'skills':
      return catalog.libraries
        .flatMap((library) => library.skills.map((skill) => ({ connectionId: library.connectionId, ...skill })))
        .filter((skill) => holds(setup, { kind: 'skill', ...skill })).length
    case 'apps':
      return catalog.apps.filter(({ name }) => holds(setup, { kind: 'app', app: name })).length
  }
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`

/**
 * A setup in a line, for the composer's button and a Persona's card: "Everything", or what each list holds, e.g.
 * "2 MCP servers · 4 skills · no apps".
 */
export function setupSummary(setup: Setup, catalog: SetupCatalog): string {
  if (setup.mcpServers === 'all' && setup.skills === 'all' && setup.apps === 'all') return 'Everything'
  const part = (category: Category, one: string, many: string) => {
    const count = heldCount(setup, category, catalog)
    return count === 'all' ? `all ${many}` : count === 0 ? `no ${many}` : plural(count, one, many)
  }
  return [
    part('mcpServers', 'MCP server', 'MCP servers'),
    part('skills', 'skill', 'skills'),
    part('apps', 'app', 'apps'),
  ].join(' · ')
}
