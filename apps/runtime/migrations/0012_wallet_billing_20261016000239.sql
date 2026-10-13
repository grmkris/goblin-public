-- goblin Pro paid by a day pass or monthly (ADR 0054, amended 2026-10-13). An account may hold two wallet subscriptions
-- while a day pass moves to monthly, so a row is keyed by its subscription, says how it is paid (`billing`), and a day
-- pass that monthly replaced is `superseded`. Every row before this was monthly. Times are epoch milliseconds.
CREATE TABLE app_billing_wallet_subscriptions_next (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  billing TEXT NOT NULL CHECK (billing IN ('day', 'month')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'grace', 'cancelled', 'lapsed', 'superseded')),
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
INSERT INTO app_billing_wallet_subscriptions_next (
  subscription_id, user_id, billing, status, amount_usd, period_days, starts_at, period, paid_through, next_attempt_at,
  grace_until, reminded_period, last_operation, last_tx, last_failure, created_at, updated_at
)
SELECT
  subscription_id, user_id, 'month', status, amount_usd, period_days, starts_at, period, paid_through, next_attempt_at,
  grace_until, reminded_period, last_operation, last_tx, last_failure, created_at, updated_at
FROM app_billing_wallet_subscriptions;
DROP TABLE app_billing_wallet_subscriptions;
ALTER TABLE app_billing_wallet_subscriptions_next RENAME TO app_billing_wallet_subscriptions;
CREATE INDEX app_billing_wallet_subscriptions_due ON app_billing_wallet_subscriptions(status, next_attempt_at);
CREATE INDEX app_billing_wallet_subscriptions_user ON app_billing_wallet_subscriptions(user_id, created_at);
