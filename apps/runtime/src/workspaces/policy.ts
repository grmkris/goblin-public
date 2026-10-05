import type { MemberPolicy } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import { Forbidden } from '../http/errors.ts'
import { unwrap } from '../http/rpc.ts'

/** The owner explicitly chooses endpoint-bound exact ceilings; remote descriptions never grant authority. */
export async function freezePolicy(
  env: RuntimeEnv,
  ownerUserId: string,
  requested: MemberPolicy,
): Promise<MemberPolicy> {
  if (requested.servers.length === 0 && requested.skills.length === 0) return requested
  const agent = env.AGENTS.getByName(ownerUserId)
  const servers = unwrap(await agent.mcpServers())
  const grants = unwrap(await agent.mcpGrants())
  for (const bound of requested.servers) {
    const server = servers.find((item) => item.serverId === bound.serverId && item.endpoint === bound.endpoint)
    if (
      server === undefined ||
      bound.tools.some(
        (name) =>
          !grants.some(
            (grant) => grant.serverId === bound.serverId && grant.capability === 'tool' && grant.name === name,
          ),
      )
    )
      throw new Forbidden({ reason: 'member ceiling exceeds owner grants' })
  }
  for (const bound of requested.skills)
    if (
      !servers.some(
        (server) => server.serverId === bound.serverId && server.endpoint === bound.endpoint && server.skillsEnabled,
      )
    )
      throw new Forbidden({ reason: 'member skill ceiling exceeds owner settings' })
  return {
    ...requested,
    servers: requested.servers.map((bound) => ({ ...bound, tools: [...new Set(bound.tools)].toSorted() })),
  }
}
