# An agent per user, with gated sign-up

Accepted 2026-10-04 at the owner's request ("make this like regular SaaS"). Supersedes the single-owner bootstrap.

Purrable started single-owner: one agent object named `root`, a user ID pinned to `owner`, and a one-time bootstrap
token for the first sign-up. Now anyone admitted by the sign-up mode gets an account, and every account owns one
`PersonalAgent` object named by its user ID. ADR 0003's design already kept everything per object (conversations, MCP
connections, encrypted credentials, grants, resident authority, inbound client sessions), so the change is confined to
identity and routing:

- The agent is chosen from authentication only: the session's user ID for the owner API, the access token's subject
  for `/mcp`. No route takes an agent name from the request.
- Inbound clients are listed and revoked per user. Revoking deletes that user's consent and refresh tokens; it no
  longer disables the client registration, which other users may share.
- Sign-up is `open`, `invite` (an invite code header) or `closed`, and deployed stages default to `closed`. Dev runs
  `invite` because every user spends the same capped model key.

Consequences: the existing dev account (user ID `owner`) now uses an agent named `owner`; the old `root` object was
left behind (it held only smoke data). Per-user daily model budgets and email verification followed the same day
(see the architecture); accounts that existed before verification were marked verified. Dev mail is sent from
`purrable@mytab.lol` because Purrable has no domain of its own yet. Account deletion followed (Settings; it erases
the agent first). Not yet built: an admin view. Verification makes each budget cost an address, not nothing; a catch-all domain still yields many.
