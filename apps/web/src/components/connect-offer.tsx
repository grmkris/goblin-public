// The first-class servers an owner has not signed in to (ADR 0043), such as Mercator, which every account starts with:
// the empty chat names the first. First-run Start (ADR 0048) is where they connect them.
import type { ServerView } from '@goblin/contracts'

/**
 * The first-class connections worth offering: signed out, while no other connection to the same server (by profile) is
 * signed in, each profile once. A second Mercator connection is not news when the first one works.
 */
export const unconnectedProfiles = (servers: readonly ServerView[]): readonly ServerView[] => {
  const connected = new Set(
    servers.flatMap((server) =>
      server.status === 'connected' && server.profile !== undefined ? [server.profile.id] : [],
    ),
  )
  const seen = new Set<string>()
  return servers.filter((server) => {
    if (server.profile === undefined || server.status === 'connected' || connected.has(server.profile.id)) return false
    if (seen.has(server.profile.id)) return false
    seen.add(server.profile.id)
    return true
  })
}
