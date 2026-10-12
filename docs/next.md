# Next: seams, not built

Where planned features attach, plus the remaining cleanup. Each new feature needs its own decision when it is built.

## Routines acceptance

Confirmed reminders, cron and MCP Events now run in fresh Pi conversations, report passively to main and obey
resident authority, current grants and confirmed scope. Settings provides exact revision review, caps and run
history. [ADR 0012](adr/0012-routines.md) records native fixtures and the remaining deployed acceptance. Real
producer Events, Railway provider accounting and Telegram completion need separate receipts; local fixtures do
not establish them.

## Connections, Tell me and Hand to acceptance

[ADR 0041](adr/0041-connections-tell-me-hand-to.md) is built and proven in local workerd: two connections to one
producer with their own webhooks, notices and notifications, the replay guard, a routine handed to a Persona through
an approval, and a Persona's holds resumed by the owner. Its done gate is a live two-bot run on Sidequest dev (a hirer
and a worker connection, skills on, events as notices, hand-overs to @Hirer and @Worker, one ask-first approval),
which waits on Sidequest's side of the Events and Skills alignment and on the owner's go for each testnet write.

## Write approvals acceptance

Per-call **Ask first** is implemented for owner-marked MCP tools ([ADR 0028](adr/0028-mcp-call-approvals.md)).
Local native tests cover exact arguments, approval/refusal, owner isolation, grant replacement, scope revocation,
routine and subagent calls, App refusal, and recovery without replay. Real Sidequest hiring and provider-side
operation reconciliation require fresh owner connections and separate deployed acceptance.

## Goblin Wallet

- **Reconciling unknown operations.** A payment whose credential left without a receipt stays `unknown` and keeps its
  reservation, as it must; there is no way yet to close one. The live pass left one: `wallet-beat3-exa-0001` holds
  $0.007 after Exa answered 402 to a credential signed against a balance the facilitator had not seen. The fix is an
  owner action that marks the operation failed and releases the hold once the credential's `validBefore` has passed
  with no matching transfer on-chain; for a transaction, once its nonce is spent by another hash.
- **Fees in the ledger.** The per-chain fee ceilings bound each signature, but the dollar windows count principal only.
- **Agent gas from the owner.** MetaMask's `NativeTokenPeriodTransferEnforcer` (v1.3.0, the same address on every
  chain) would let the agent redeem a capped ETH allowance for its own gas, so the owner pays every fee.
- **Paid inference.** Users paying for their own inference from the wallet: OpenRouter OAuth PKCE or BYOK, or MPP
  sessions for an OpenAI-compatible endpoint on Tempo. The wallet speaks MPP `charge` today, not sessions.
- **Self-sent upgrade.** Privy's embedded wallet answers HTTP 500 to a type-4 transaction, so the relay sends the
  owner's EIP-7702 upgrade; the owner can fund the relay.

## Smaller items

- `app_metadata` is created by the application migrations, but its `AppMetadata` service is used only by the
  integration test worker; remove it or give it a job.
- A production stage is live at `https://goblin.surf`: its own D1, credential key, files bucket and capped model key; nothing is shared with dev. The first public release is invite-only and owner OTP/bootstrap remains an operator step.
- Dev is live at `https://dev.goblin.surf`: its fresh auth D1 and PersonalAgent namespace were verified empty before
  bootstrap, the owner signed in with delivered OTP from `hello@goblin.surf` (SPF, DKIM and DMARC passed), and signup
  is closed after bootstrap. The owner has an explicit dev-only Pro override of its daily allowance (in Credits since ADR 0026). The
  dedicated provider key separately caps aggregate spending at $10 per 30 days and restricts offered models. Live
  acceptance passed health, closed-signup refusal, OTP browser login, desktop/mobile layout, OAuth/MCP consent, model
  turns, thread sharing, subagents, memory and client revocation. Reopening signup needs a global account-admission
  policy and provider capacity review. Production payment acceptance and merchant onboarding remain separate work;
  dev's operator override grants nothing on prod.
  Acceptance was recorded on 2026-10-06; the previous dev resources were retired afterwards. Suggested outbound MCP
  connections remain disconnected and ungranted, so live acceptance proves inbound MCP and models; outbound calls
  await fresh owner connections and grants.
