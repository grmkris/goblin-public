import type { Allowed, SetupCatalog, SetupItem } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { AppEngine } from '../agent-apps/service.ts'
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
  const labels = new Map(
    servers.map((server) => [server.serverId, server.title ?? server.serverName ?? server.serverId]),
  )
  const listed = yield* Effect.forEach(servers, (server) =>
    Effect.map(connections.snapshot(server.serverId), (snapshot) => Option.getOrUndefined(snapshot)?.tools),
  )
  const withTools = servers.flatMap((server, index) => {
    const tools = grants.flatMap(({ serverId, capability, name }) => {
      if (serverId !== server.serverId || capability !== 'tool') return []
      const tool = listed[index]?.find((candidate) => candidate.name === name)
      if (tool !== undefined && !toolOffered(tool, 'model')) return []
      return [{ name, ...(tool?.title === undefined ? {} : { title: tool.title }) }]
    })
    return tools.length === 0
      ? []
      : [
          {
            serverId: server.serverId,
            label: labels.get(server.serverId) ?? server.serverId,
            status: server.status,
            tools,
          },
        ]
  })
  const skills = yield* Skills
  const sources = yield* skills.sources()
  const catalog = yield* skills.catalog({ timeout: 5000 }, () => true)
  const libraries = sources.map((serverId) => ({
    serverId,
    label: labels.get(serverId) ?? serverId,
    available: !catalog.unavailable.includes(serverId),
    skills: catalog.skills
      .filter((skill) => skill.serverId === serverId)
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
      return allowed.servers.some((server) => server.serverId === item.serverId)
    case 'tool':
      return allowed.servers.some(
        (server) => server.serverId === item.serverId && server.tools.some((tool) => tool.name === item.name),
      )
    case 'library':
      return allowed.libraries.some((library) => library.serverId === item.serverId)
    case 'skill':
      return allowed.libraries.some(
        (library) => library.serverId === item.serverId && library.skills.some((skill) => skill.name === item.name),
      )
    case 'app':
      return allowed.apps.some((app) => app.name === item.app)
    case 'subagents':
      return true
  }
}
