# ADR 0028: Owner approval for an exact MCP call

Status: Accepted

## Context

A standing MCP tool grant allows recurring calls. A spending or destructive tool may also need a fresh owner
decision for each call. Remote descriptions and annotations are untrusted and cannot choose that policy. Public
asset fields such as `rewardToken` and a write's `operationKey` must remain visible when credential-shaped fields
are redacted.

## Decision

The owner marks a granted tool **Ask first** under Connections. Pi's `beforeTool` prepares its approval; the tool
body repeats the gate and emits a terminating local approval result. No Pi task stays parked waiting for a person.
The browser trusts only local `mcp_call` markers matching the exact target, then fetches the durable record through
the authenticated, same-origin CSRF-protected owner API. Later conversation messages grant nothing.

Application SQLite stores immutable AES-GCM encrypted arguments and remote results, outside vendor tables. A
record binds the endpoint, grant version, caller, conversation, source call and task. Changing or replacing a grant
invalidates its previous approvals. Approval expires after ten minutes; at most 32 unexpired approvals may wait,
each with at most 64 KiB of arguments. Records are retained for thirty days after expiry, then pruned on startup.
Only credential-shaped keys are hidden in the owner view; dispatch reads the original sealed arguments.

The owner decision transitions pending to approved or refused once. Every shared MCP dispatch checks the reviewed
identity and arguments, current grant, resident authority and conversation/routine scope after waits. Immediately
before the first HTTP attempt a compare-and-set moves approved to dispatching. No automatic OAuth/transport retry
can repeat that attempt. The response is sealed before model continuation under a stable submission id. A rejected
preflight is failed; interrupted dispatch is uncertain. Reconstruction never replays either and marks an approved
but undispatched decision failed. This bounds attempts; it does not establish exactly-once external effects.

Routine approvals release the executing slot while retaining the routine lock and deadline; approval resumes the
same run. A waiting subagent stays open for the owner. Autonomous App and other alternate MCP callers are refused
at the shared seam for an ask-first tool. Explicit owner console calls remain direct owner acts. MCP Apps do not
receive a way to approve calls or change owner policy.

## Validation and limits

Native workerd tests use actual owner authentication, D1, Agent SQLite, Pi and an injected official MCP transport.
They verify frozen arguments and `operationKey`, redacted review, approval/refusal, second-account isolation,
grant replacement, scope revocation, routine and subagent holds, App refusal, manual owner calls and reconstructed
uncertainty. Web unit tests reject remote approval markers. These checks do not prove real Sidequest hiring, a
provider's idempotency, or production owner acceptance.
