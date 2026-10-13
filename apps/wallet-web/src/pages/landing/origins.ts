// Where the landing points: this wallet's own MCP endpoint, and the goblin that shares its stage. Both come from the
// page's own origin, so wallet-dev.goblin.surf shows its own endpoint and links to dev.goblin.surf.

const PROD_GOBLIN = 'https://goblin.surf'

/** "https://wallet.goblin.surf/mcp": the address an MCP client connects to. */
export const mcpEndpoint = (origin: string): string => `${origin}/mcp`

/** The Claude Code command that adds this wallet as a remote MCP server. */
export const claudeCodeCommand = (endpoint: string): string =>
  `claude mcp add --transport http goblin-wallet ${endpoint}`

/**
 * goblin beside this wallet: `wallet.<domain>` is `<domain>`, `wallet-<stage>.<domain>` is `<stage>.<domain>`. Any other
 * host (a local preview) links to goblin.surf.
 */
export function goblinSite(origin: string): string {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // expected: not an origin at all; the public site is the honest default
    return PROD_GOBLIN
  }
  const match = /^wallet(?:-(?<stage>[a-z0-9-]+))?\.(?<domain>.+\..+)$/u.exec(url.hostname)
  const domain = match?.groups?.domain
  if (url.protocol !== 'https:' || domain === undefined) return PROD_GOBLIN
  const stage = match?.groups?.stage
  return stage === undefined ? `https://${domain}` : `https://${stage}.${domain}`
}
