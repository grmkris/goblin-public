import {
  type Allowed,
  type PersonaSetup,
  type SetupCatalog,
  type SetupItem,
  type TopicSetup,
  holds,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { AppEngine } from '../agent-apps/service.ts'
import { InvalidInput } from '../http/errors.ts'
import { McpConnections, McpGrants, McpServers } from '../mcp/service.ts'
import { toolOffered } from '../mcp/remote.ts'
import { Skills } from '../skills/service.ts'

/**
 * What a setup can be chosen from now (ADR 0040): each server with at least one tool the owner granted that the model
 * may call (a tool its live listing offers only to Apps is left out; without a listing every granted tool is shown),
 * each skill server the owner turned on with the skills it lists (from the library's cache, `available: false` when it
 * cannot be read now), and every agent app. Labels are the servers' and apps' own, display data only.
 */
export const setupCatalog = Effect.gen(function* () {
  const connections = yield* McpConnections
  const servers = yield* (yield* McpServers).list()
  const grants = yield* (yield* McpGrants).list()
  const labels = new Map(servers.map((server) => [server.connectionId, server.label]))
  const listed = yield* Effect.forEach(servers, (server) =>
    Effect.map(connections.snapshot(server.connectionId), (snapshot) => Option.getOrUndefined(snapshot)?.tools),
  )
  const withTools = servers.flatMap((server, index) => {
    const tools = grants.flatMap(({ connectionId, capability, name }) => {
      if (connectionId !== server.connectionId || capability !== 'tool') return []
      const tool = listed[index]?.find((candidate) => candidate.name === name)
      if (tool !== undefined && !toolOffered(tool, 'model')) return []
      return [{ name, ...(tool?.title === undefined ? {} : { title: tool.title }) }]
    })
    return tools.length === 0
      ? []
      : [
          {
            connectionId: server.connectionId,
            label: labels.get(server.connectionId) ?? server.connectionId,
            status: server.status,
            tools,
          },
        ]
  })
  const skills = yield* Skills
  const sources = yield* skills.sources()
  const catalog = yield* skills.catalog({ timeout: 5000 }, () => true)
  const libraries = sources.map((connectionId) => ({
    connectionId,
    label: labels.get(connectionId) ?? connectionId,
    available: !catalog.unavailable.includes(connectionId),
    skills: catalog.skills
      .filter((skill) => skill.connectionId === connectionId)
      .map((skill) => ({ name: skill.name, uri: skill.entry.uri, description: skill.description.slice(0, 300) })),
  }))
  const apps = (yield* (yield* AppEngine).summaries).map(({ name, title }) => ({ name, title }))
  return { servers: withTools, libraries, apps } satisfies SetupCatalog
})

/**
 * Whether the owner allows `item` now: what the agent may add to a setup (ADR 0040). A server with a granted tool, one
 * of those tools, a library the owner turned on, one of the skills it lists, an app that exists; subagents always.
 */
export function allows(allowed: Allowed, item: SetupItem): boolean {
  switch (item.kind) {
    case 'server':
      return allowed.servers.some((server) => server.connectionId === item.connectionId)
    case 'tool':
      return allowed.servers.some(
        (server) => server.connectionId === item.connectionId && server.tools.some((tool) => tool.name === item.name),
      )
    case 'library':
      return allowed.libraries.some((library) => library.connectionId === item.connectionId)
    case 'skill':
      return allowed.libraries.some(
        (library) =>
          library.connectionId === item.connectionId && library.skills.some((skill) => skill.name === item.name),
      )
    case 'app':
      return allowed.apps.some((app) => app.name === item.app)
    case 'subagents':
      return true
  }
}

/** Every item the list categories of `setup` name: what an edit is checked for adding. */
const listedItems = (setup: TopicSetup | PersonaSetup): readonly SetupItem[] => [
  ...(setup.mcpServers === 'all'
    ? []
    : setup.mcpServers.flatMap(({ connectionId, tools }): SetupItem[] =>
        tools === 'all'
          ? [{ kind: 'server', connectionId }]
          : tools.map((name) => ({ kind: 'tool', connectionId, name })),
      )),
  ...(setup.skills === 'all'
    ? []
    : setup.skills.map(({ connectionId, name }): SetupItem =>
        name === undefined ? { kind: 'library', connectionId } : { kind: 'skill', connectionId, name },
      )),
  ...(setup.apps === 'all' ? [] : setup.apps.map((app): SetupItem => ({ kind: 'app', app }))),
]

/** What `next` lists that `before` did not hold and the owner does not allow now. */
export const unallowed = (
  before: TopicSetup | PersonaSetup,
  next: TopicSetup | PersonaSetup,
  allowed: Allowed,
): readonly SetupItem[] => listedItems(next).filter((item) => !holds(before, item) && !allows(allowed, item))

/**
 * Refuses (`InvalidInput` `setup_not_allowed`) a setup that lists something `before` did not hold and the owner does not
 * allow now: what the agent may not add to a Topic's or a Persona's setup (ADR 0040). The catalog is read only when the
 * setup lists something new.
 */
export const refuseUnallowed = (before: TopicSetup | PersonaSetup, next: TopicSetup | PersonaSetup) =>
  Effect.gen(function* () {
    if (listedItems(next).every((item) => holds(before, item))) return
    if (unallowed(before, next, yield* setupCatalog).length > 0)
      return yield* new InvalidInput({ reason: 'setup_not_allowed' })
  })
