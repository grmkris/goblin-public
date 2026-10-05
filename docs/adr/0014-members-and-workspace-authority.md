# ADR 0014: Members and workspace authority

Status: accepted; Phase A is in progress, member execution is held for Phase B.

The approved 2026-10-05 plan allows a user to join another user's agent. Each member needs their own active Pro
plan and pays from their own allowance. The owner can read every conversation in their workspace. Roles are member
and viewer; invitation choices for servers and skills start empty. Telegram remains the owner's channel.

This amends ADRs 0001, 0003 and 0004 and the root AGENTS routing invariant. Auth D1 keeps additive `app_*` workspace,
membership, invitation, admission, session-selection and audit metadata through Drizzle. Better Auth still owns its
tables and uses its official adapter with `mcp()` and `jwt()`. Existing Agent names remain the owner user ID;
backfilling metadata preserves their SQLite, Pi history and credentials.

The Worker resolves the selected workspace from a cookie session and active D1 membership. A client can request a
selection but cannot supply an Agent name or role. The opaque selection context belongs to one session; a stale
context returns 409 and a foreign or revoked workspace returns 404. Selection writes require exact Origin and
`x-purrable-csrf: 1`. Hooks and inbound MCP resolve the authenticated owner's workspace independently of browser
selection. Invitation-only accounts never provision a personal Agent or fall back to their account ID.

Phase A closes every existing owner RPC to members and viewers. A membership does not renew resident authority,
expose credentials or grant owner methods. Phase B must add immutable requester provenance, visibility filters,
requester-directed questions, live D1 invalidation and the member ceiling inside ADR 0010's capability scope before
opening shared execution. Routines, Events and subagents retain their own ceilings (ADRs 0011–0013); no policy can
widen owner grants. Member usage, including descendants and ancillary model work, must use the acting account's
allowance rather than partitioning the owner's allowance.

Owner deletion first marks the workspace deleting and revokes foreign memberships before calling native
`Agent.destroy()`. A failed destruction keeps access closed and the account retryable. Only confirmed destruction,
including the SDK's known destroyed-isolate abort, marks the workspace deleted and permits Better Auth deletion.
Deleting an invitation-only member account never looks up a personal Agent; deleting any member preserves foreign
owners. Retained transcripts are removed with the workspace; forgetting OAuth credentials is not remote revocation.

Local workerd tests prove stable owner routing, selection/CSRF fences, closed member/viewer RPCs and deletion
failure/retry with real D1. Live paid invitations and Phase B privacy, provenance, budgets and invalidation acceptance
remain separate gates before the complete Members milestone can be claimed.
