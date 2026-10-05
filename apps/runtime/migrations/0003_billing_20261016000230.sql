CREATE TABLE app_billing_accounts (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  customer_id TEXT UNIQUE, plan_override TEXT CHECK (plan_override IS NULL OR plan_override = 'pro'),
  override_stage TEXT, daily_tokens INTEGER CHECK (daily_tokens IS NULL OR daily_tokens > 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE app_billing_subscriptions (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('test_mode', 'live_mode')), customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER, past_due_ends_at INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0, provider_updated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX app_billing_subscriptions_user ON app_billing_subscriptions(user_id, updated_at);
CREATE TABLE app_billing_inbox (
  id TEXT PRIMARY KEY NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('test_mode', 'live_mode')),
  type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processed', 'ignored', 'orphaned', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT
);
CREATE INDEX app_billing_inbox_pending ON app_billing_inbox(mode, state, received_at);
CREATE TABLE app_billing_checkouts (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
);
CREATE INDEX app_billing_checkouts_user ON app_billing_checkouts(user_id, created_at);
-- Only this existing cohort receives a dev-only operator override. It grants nothing on prod, even with old users.
INSERT INTO app_billing_accounts (user_id, plan_override, override_stage, daily_tokens, created_at, updated_at)
SELECT id, 'pro', 'dev', 2000000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM user;
