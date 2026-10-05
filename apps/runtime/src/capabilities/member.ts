import type { MemberPolicy } from '@purrable/contracts'
import type { CapabilityScope } from './profiles.ts'

/** Hydrated from authoritative membership, never a model argument or an author label. */
export type MemberBound = {
  readonly policy: MemberPolicy
  readonly role: 'member' | 'viewer'
  readonly endpoint: (serverId: string) => string | undefined
  readonly telegramServer: string | undefined
}

/** Intersect the existing conversation/routine scope with an endpoint-bound member ceiling. */
export function memberScope(scope: CapabilityScope, bound: MemberBound): CapabilityScope {
  const server = (id: string) =>
    bound.role === 'member' &&
    id !== bound.telegramServer &&
    bound.policy.servers.some((item) => item.serverId === id && item.endpoint === bound.endpoint(id))
  return {
    editable: false,
    server: (id) => scope.server(id) && server(id),
    tool: (id, name) =>
      scope.tool(id, name) &&
      server(id) &&
      bound.policy.servers.some((item) => item.serverId === id && item.tools.includes(name)),
    skills: (id) =>
      bound.role === 'member' &&
      id !== bound.telegramServer &&
      scope.skills(id) &&
      bound.policy.skills.some((item) => item.serverId === id && item.endpoint === bound.endpoint(id)),
    subagents: () => bound.role === 'member' && scope.subagents(),
  }
}
