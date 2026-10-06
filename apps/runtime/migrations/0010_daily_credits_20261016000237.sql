-- The daily allowance counts estimated Alibaba Token Plan Credits (ADR 0026), not tokens. An override set in tokens
-- carries over at 2,500 tokens per Credit (2,000,000 tokens become 800 Credits, Pro's allowance). daily_tokens stays,
-- unread, so a revert of the runtime still finds it.
ALTER TABLE app_billing_accounts ADD COLUMN daily_credits INTEGER CHECK (daily_credits IS NULL OR daily_credits > 0);
UPDATE app_billing_accounts SET daily_credits = max(1, daily_tokens / 2500) WHERE daily_tokens IS NOT NULL;
