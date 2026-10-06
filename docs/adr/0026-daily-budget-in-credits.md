# ADR 0026: The daily budget is estimated Token Plan Credits

Accepted 2026-10-06 with the owner.

**The budget counts what the model plan charges.** goblin's users share one model key on Alibaba's Token Plan
(Standard: 45,000 Credits a month, shared with the owner's coding agents and Hermes). The plan bills Credits, and
prices a cached input token at about a tenth of a fresh one and an output token at about six times. The budget used
to count every token as one, so a turn that re-read a cached 40K-token prefix cost the same as one that read it fresh,
and long answers were cheap. Each response is now priced in estimated Credits at its model's rate:

- by default about 5,000 fresh input, 50,000 cached input or 830 output tokens per Credit, Alibaba's own example;
- `GOBLIN_MODEL_CREDIT_RATES` sets a default, per-model rates and aliases; Gemini 3.8 Flash, which the plan does not
  list, is priced as Qwen 3.8 Flash; a cache write is priced as fresh input; reasoning tokens are output;
- usage is kept in thousandths of a Credit beside the tokens (`app_usage_daily.milli_credits`), so small calls count.

**The allowance is 800 Credits a day for Pro**, about the 2 million tokens it was. An operator override is
`app_billing_accounts.daily_credits`; overrides set in tokens carried over at 2,500 tokens per Credit (D1 migration
`0010_daily_credits`), and `daily_tokens` is no longer read.

**Everything that spends counts the same way:** turns in main, threads and subagents (`pi/budget.ts`), the cheap
model's calls (thread titles, memory, skill drafts, an app's `llm` power) and routine runs, whose usage is projected
from Pi's `pi.usage` counters. A routine's own caps (`tokensPerRun`, `tokensPerDay`) stay in tokens, as the owner
approved them.

Consequences:
- The owner sees Credits in Settings and on the Billing page; the composer ring is a share of the day either way.
- The rates are estimates: the plan's real charges, its night discount and models it prices differently are not
  modelled. Operators review the rates against the plan's billing.
- Today's spend restarts at zero Credits on the day this ships; earlier tokens stay recorded.
- Compaction summaries in main and threads still go uncounted (Pi records them in `pi.usage` without the hook).
- The public terms still say "2 million weighted tokens"; the owner updates the legal text.
