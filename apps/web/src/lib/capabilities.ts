import type { CapabilityChange, CapabilityTarget, ConversationCapabilities } from '@purrable/contracts'

type View = ConversationCapabilities
type Server = View['servers'][number]

/**
 * How much of what a conversation could use is on: each granted tool (off under a server switched off), each skills
 * library and starting subagents. The composer shows "3 of 5" only when something is off.
 */
export function capabilityCount(view: View): { readonly on: number; readonly total: number } {
  const tools = view.servers.flatMap((server) => server.tools.map((tool) => server.on && tool.on))
  const switches = [...tools, ...view.skills.map((library) => library.on), view.subagents]
  return { on: switches.filter(Boolean).length, total: switches.length }
}

/** A server's switch as its row shows it: on, off, or on with some of its tools switched off. */
export function serverState(server: Server): 'on' | 'some' | 'off' {
  if (!server.on || server.tools.every((tool) => !tool.on)) return 'off'
  return server.tools.every((tool) => tool.on) ? 'on' : 'some'
}

/**
 * The view with one change made, shown until the server answers with the real one. A reset cannot be guessed here (it
 * copies its parent's switches), so it changes nothing until then.
 */
export function applyChange(view: View, change: CapabilityChange): View {
  if ('reset' in change) return view
  const { target, on } = change
  const { sameAsParent: _unknown, ...rest } = view
  switch (target.kind) {
    case 'subagents':
      return { ...rest, subagents: on }
    case 'skills':
      return {
        ...rest,
        skills: view.skills.map((library) => (library.serverId === target.serverId ? { ...library, on } : library)),
      }
    case 'server':
      return {
        ...rest,
        servers: view.servers.map((server) => (server.serverId === target.serverId ? { ...server, on } : server)),
      }
    case 'tool':
      return {
        ...rest,
        servers: view.servers.map((server) =>
          server.serverId === target.serverId
            ? { ...server, tools: server.tools.map((tool) => (tool.name === target.name ? { ...tool, on } : tool)) }
            : server,
        ),
      }
  }
}

/** A target as the owner reads it, named after its server's label where the view has one. */
export function targetLabel(target: CapabilityTarget, view?: View): string {
  if (target.kind === 'subagents') return 'Subagents'
  const label = view?.servers.find((server) => server.serverId === target.serverId)?.label ?? target.serverId
  if (target.kind === 'skills')
    return `Skills from ${view?.skills.find((library) => library.serverId === target.serverId)?.label ?? label}`
  return target.kind === 'tool' ? `${label} · ${target.name}` : label
}
