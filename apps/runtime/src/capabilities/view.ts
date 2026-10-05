import type { Tool } from '@modelcontextprotocol/client'
import type { CapabilityTarget, ConversationCapabilities, ServerView } from '@purrable/contracts'
import { toolOffered } from '../mcp/connection.ts'
import type { Grant } from '../mcp/grants.ts'
import { type CapabilityScope, type Exclusion, exclusionOf, sameExclusions, scopeOf } from './profiles.ts'

/** What a conversation's switches are shown over: the agent's servers, the owner's grants and skills libraries. */
export type CapabilityInput = {
  readonly thread: string
  readonly kind: ConversationCapabilities['kind']
  readonly servers: readonly ServerView[]
  readonly grants: readonly Grant[]
  /** A server's tools as its live connection last listed them, when it has one (nothing is connected for this). */
  readonly listed: (serverId: string) => readonly Tool[] | undefined
  /** The servers whose skills the owner turned on. */
  readonly skillSources: readonly string[]
  readonly own: readonly Exclusion[]
  /** What Reset gives a thread: the switches of the conversation it came from. */
  readonly inherited: readonly Exclusion[]
}

const labelOf = (server: ServerView): string => server.title ?? server.serverName ?? server.serverId

/**
 * The servers a conversation can narrow: each with at least one granted tool, and those tools. A tool the live listing
 * offers only to Apps is left out, since the agent never calls it; without a listing every granted tool is shown. A
 * tool's `on` is its own switch: under a server switched off it is off either way.
 */
function serversOf(input: CapabilityInput, scope: CapabilityScope): ConversationCapabilities['servers'] {
  const toolsOff = new Set(input.own.filter((row) => row.kind === 'tool').map((row) => `${row.serverId}\n${row.name}`))
  return input.servers.flatMap((server) => {
    const { serverId } = server
    const listing = input.listed(serverId)
    const tools = input.grants.flatMap(({ serverId: granted, capability, name }) => {
      if (granted !== serverId || capability !== 'tool') return []
      const tool = listing?.find((candidate) => candidate.name === name)
      if (tool !== undefined && !toolOffered(tool, 'model')) return []
      const title = tool?.title === undefined ? {} : { title: tool.title }
      return [{ name, ...title, on: !toolsOff.has(`${serverId}\n${name}`) }]
    })
    if (tools.length === 0) return []
    return [{ serverId, label: labelOf(server), status: server.status, on: scope.server(serverId), tools }]
  })
}

/** A conversation's switches over everything it could use. */
export function capabilityView(input: CapabilityInput): ConversationCapabilities {
  const scope = scopeOf(input.own, input.kind !== 'subagent')
  const labels = new Map(input.servers.map((server) => [server.serverId, labelOf(server)]))
  return {
    thread: input.thread,
    kind: input.kind,
    servers: serversOf(input, scope),
    skills: input.skillSources.map((serverId) => ({
      serverId,
      label: labels.get(serverId) ?? serverId,
      on: scope.skills(serverId),
    })),
    subagents: scope.subagents(),
    ...(input.kind === 'thread' && { sameAsParent: sameExclusions(input.own, input.inherited) }),
  }
}

/** Whether `target` is something the view offers to switch: what may be switched off is only what is shown. */
export function offers(view: ConversationCapabilities, target: CapabilityTarget): boolean {
  const { kind, serverId, name } = exclusionOf(target)
  if (kind === 'subagents') return true
  if (kind === 'skills') return view.skills.some((library) => library.serverId === serverId)
  const server = view.servers.find((candidate) => candidate.serverId === serverId)
  return kind === 'server' ? server !== undefined : (server?.tools.some((tool) => tool.name === name) ?? false)
}
