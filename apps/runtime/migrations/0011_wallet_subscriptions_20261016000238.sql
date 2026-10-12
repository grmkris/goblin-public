-- goblin Pro paid as a signed USDC subscription (ADR 0054): one row per account, the subscription its owner signed in
-- the Goblin Wallet and where its renewals stand. Times are epoch milliseconds.
CREATE TABLE app_billing_wallet_subscriptions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'grace', 'cancelled', 'lapsed')),
  amount_usd TEXT NOT NULL,
  period_days INTEGER NOT NULL CHECK (period_days > 0),
  starts_at INTEGER NOT NULL,
  period INTEGER NOT NULL DEFAULT 0 CHECK (period >= 0),
  paid_through INTEGER,
  next_attempt_at INTEGER,
  grace_until INTEGER,
  reminded_period INTEGER NOT NULL DEFAULT 0,
  last_operation TEXT,
  last_tx TEXT,
  last_failure TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX app_billing_wallet_subscriptions_due ON app_billing_wallet_subscriptions(status, next_attempt_at);
