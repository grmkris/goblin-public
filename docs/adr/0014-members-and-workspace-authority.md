# ADR 0014: Members and workspace authority

Status: accepted; Phase A implemented, member execution is held for Phase B.

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

Established workspace resolution uses one live joined D1 read and performs no writes. It reads account kind,
owned workspace, active membership, owner identity and session selection together; it caches no authority.
Provisioning and initial owner selection write only on the cold path. Deleted/deleting ownership still prevents
re-provisioning, and a removed selection never falls back to the user's personal workspace.

Invitations use a seven-day 256-bit fragment secret or independent 80-bit invitation code. Only hashes are stored.
The page removes the fragment before proof exchange; responses are no-store/no-referrer. Exact Origin and CSRF proof
are required to mint a ten-minute Secure/HttpOnly/SameSite admission cookie. Proof attempts are bounded per IP and
invitation. Closed sign-up admits only the addressed email through the existing six-digit sign-in OTP, rechecking
invitation version, expiry and workspace state at send, verification and account hooks. Invitation accounts never
become ordinary admissions. A fresh verified session and the invitee's own active plan are required to accept.

Acceptance commits membership, invitation consumption and admission consumption in one guarded D1 batch. A replay
returns its first receipt without reactivating a removed membership. Resend rotates both proofs and revokes earlier
admissions. Owner mutations use version CAS and operation receipts; leave rejects policy/role payloads, permits
unpaid exit and replays only the actor's original receipt. Sixteen active/pending invitees and ten sends per hour
bound each workspace. Mail is sent after persistence; a failed or interrupted send requires explicit rotation and
resend, with no claim of exactly-once delivery.

Acceptance retains the admission cookie's original ten-minute expiry so a browser can retry after a partially
observed response. A used admission returns only the original accepting account's receipt, with no membership
change. Replays never renew that cookie or its D1 expiry.

The hourly Worker cron prunes at most 1000 expired admissions and 1000 rate-limit buckets per tick through indexed
expiry queries, even without Dodo configuration. It retains every unexpired admission, including used proofs needed
for acceptance retries, and all rate buckets younger than one hour to preserve invitation-send counters. An expiry
backlog drains over subsequent ticks; this bounds each sweep, not total storage under sustained abuse.

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

Local workerd tests prove stable owner routing, selection/CSRF fences, paid email-bound invitation acceptance,
concurrent/replayed acceptance, proof rotation/expiry, one-read workspace resolution without writes, bounded cron
cleanup without Dodo, closed member/viewer RPCs and deletion failure/retry with real
D1 and injected mail. Chromium fixture tests cover the Settings and invitation flows; they make no provider calls. Live paid invitations and Phase B privacy, provenance, budgets and invalidation acceptance
remain separate gates before the complete Members milestone can be claimed.
