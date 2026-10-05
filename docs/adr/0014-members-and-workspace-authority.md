# ADR 0014: Members and workspace authority

Status: **Withdrawn 2026-10-05**. Kris dropped Members after the
[Phase B security review](https://example.invalid/private-reference) identified unsafe owner-labelled
member projections. All feature code is removed; git history retains the implementation. Every user again reaches
only their own Agent. Applied auth D1 and DO migrations and their data remain dormant under the additive rule.

The decision below is historical and no longer describes the runtime.

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

Every existing owner RPC remains closed to members and viewers. A membership does not renew resident authority,
expose credentials or grant owner methods. Shared execution uses immutable requester provenance, visibility filters,
requester-directed questions, live D1 invalidation and the member ceiling inside ADR 0010's capability scope.
Routines, Events and subagents retain their own ceilings (ADRs 0011, 0012 and 0017); no policy can
widen owner grants. Member usage, including descendants and ancillary model work, must use the acting account's
allowance rather than partitioning the owner's allowance.

Owner deletion first marks the workspace deleting and revokes foreign memberships before calling native
`Agent.destroy()`. A failed destruction keeps access closed and the account retryable. Only confirmed destruction,
including the SDK's known destroyed-isolate abort, marks the workspace deleted and permits Better Auth deletion.
Deleting an invitation-only member account never looks up a personal Agent; deleting any member preserves foreign
owners. Retained transcripts are removed with the workspace; forgetting OAuth credentials is not remote revocation.

Local workerd tests prove stable owner routing, selection/CSRF fences, paid email-bound invitation acceptance,
concurrent/replayed acceptance, proof rotation/expiry, one-read workspace resolution without writes, bounded cron
cleanup without Dodo, closed owner RPCs and deletion failure/retry with real D1 and injected mail. Chromium fixture
tests cover the Settings and invitation flows; they make no provider calls. Native Phase B tests cover privacy,
provenance, acting-account allowance, designated questions and invalidation. Live paid invitations and deployed
acceptance remain separate gates before the complete Members milestone can be claimed.

Phase B adds principal-bound member main/private conversations, immutable requester receipts, the member
ceiling inside `Capabilities.scope`, designated questions and sealed exact-action owner approvals. An owner reads
all conversations but cannot submit an owner turn into a member context. Private creation bypasses root copying,
memory recall and automatic title/learner work; forks require a readable source, and named readers receive no write
permission. A membership version change fences old contexts and descendants. Member main replies use an application
outbox for passive root records. Committed Pi usage is projected with cumulative D1 watermarks across workspaces into
the acting account's allowance; viewers cannot execute. Telegram and inbound owner clients remain owner-only.

The runtime defaults `MEMBER_EXECUTION_ENABLED` to closed; the reviewed Alchemy Worker binding explicitly enables it
on configured stages, while the isolated native Members fixture opts in and its closed regression strips the binding. Member
HTTP writes require exact Origin and CSRF proof, and filtered streams revalidate D1 before batches and on idle ticks.
Approval acceptance consumes the exact requester/version/hash receipt before a dispatch, checks current scope and
owner grants again on transport retries, and never repeats a consumed dispatch after a crash. Wider permissions
require a policy revision or Connections consent. Local fixtures do not establish provider billing, real mail,
live membership acceptance or exactly-once external effects.

Named readers are membership/version bound and cannot revive a fenced creator context. Member policy changes,
leave and removal queue an invalidation in the same D1 batch; mutation retries and the hourly cron retry failed
aborts without recreating a deleted owner's Agent. Late cleanup cancels only interactions from fenced versions.
Question/approval outcomes are private durable receipts; viewer access requests only record an owner response and
never start model work. Native fixtures verify these boundaries; real delivery and provider billing remain unproven.
