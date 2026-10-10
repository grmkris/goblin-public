# ADR 0015: Plans and payments

Accepted implementation decision, 2026-10-05. Live payment and legal acceptance remain operator gates. Amended
2026-10-10 (see Amendments).

goblin accounts sign up before paying. Pro costs $10/month through Dodo Payments, with no trial or free tier,
and grants 2M weighted tokens per account per UTC day. Unsubscribed accounts can sign in and manage account/billing
settings, but cannot reach their Agent through the owner API, MCP or a hook. Routines and subagents use the
same `Entitlements` service; their tunable limits belong to their own milestones.

Billing application tables live in auth D1 through Drizzle, alongside isolated Better Auth identity tables. Pi
continues to own Agent transcripts and execution. The billing migration is additive and grants only the existing
cohort a dev-scoped override. Prod gets separate D1 and secrets; a dev override grants nothing there. Operators may
set an account's own positive daily allowance. Admission reads current plan state, so revoked/expired plans cannot
be kept alive by a cached DO entitlement.

The server selects a single recurring product and binds checkout metadata to the authenticated account. A checkout
URL or its return does not grant authority. Standard Webhooks verification checks the raw body and five-minute
freshness, then stores its first body durably under `webhook-id`. Short D1 batches and lease-token guarded progress
make redelivery idempotent. Processing continues through Worker `waitUntil`; hourly reconciliation retries pending,
failed or orphaned records (bounded attempts) and reads stale subscriptions from Dodo. Old provider timestamps cannot
replace newer state. This is not a claim of exactly-once external payment effects.

A cancelled subscription keeps access through its recorded paid period. Failed renewal keeps it through Dodo's grace
end, or three days after the period end if no explicit grace is given. Missing periods fail closed. Refund/dispute
notifications read the provider's subscription back; they do not infer payment outcomes. The billing portal owns
cancellation. Deleting an account is separate and does not automatically cancel provider billing.

Price multipliers are explicit stage configuration and default to one. Both Pi replies and cheap memory/title calls
record weighted spend. Native tests prove per-account limits and weighted counting; the production price schedule is
pending operator input. The usage ledger belongs to each owner's Agent.

Local workerd tests use actual Better Auth D1, real Agent storage and an injected Dodo client, proving signup,
checkout without entitlement, verified activation, paid admission, replay, stale updates, cancellation/grace and
operator allowance isolation. They do not prove Dodo API reachability, real test-card checkout or live delivery.
Test mode is required outside prod; prod requires live mode. All payment keys/product IDs are Worker secret bindings.

Terms, privacy and refund pages are drafts. Prod live payments require operator identity, contact, jurisdiction,
refund/withdrawal and privacy review, Dodo live configuration and Kris's production go. A real dev test checkout and
webhook receipt remain acceptance gates until test keys and product are supplied through operator env updates.

## Amendments

- **2026-10-10: the agent keeps an active plan for a minute.** "Admission reads current plan state" now holds at the
  Worker edge only: every owner request, MCP call and hook still reads the plan fresh from auth D1 before it reaches
  the Agent, so an owner whose plan lapsed is refused at once. Inside the Agent (owner admission, routine dispatch, the
  model budget, every tool call) the plan comes from `Entitlements`, which keeps an active plan for 60 seconds
  (`cachedPolicy` in `billing/gates.ts`); about four D1 reads per tool call become at most one a minute. A plan that
  is not active, or a read that failed, is not kept, so a new subscription counts at once and a D1 failure is retried
  on the next check. A cancelled plan can keep the Agent's own background work (routines, alarms) going for up to a
  minute after the edge stops admitting the owner.
- **2026-10-10, later: hooks and inbound MCP use the plan the agent keeps.** Only the owner's own requests (and the
  account API's `clients`) still read the plan fresh at the Worker edge. An MCP client's ask and recent read,
  myagent's doorbell and a signed MCP Event reach the Agent through its internal API (ADR 0038, amended), whose gate
  checks the plan once through `Entitlements`, as does the Events ingress's own authority check; a refused plan
  answers 402. A plan lookup that failed is not a refusal: an Events webhook is answered 503, so the producer keeps
  the subscription and retries, and the other internal calls fail as `Internal`. A lapsed plan can therefore still
  reach the Agent on these paths for up to a minute, as it can keep its background work going.
