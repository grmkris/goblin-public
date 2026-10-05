-- Account-wide member usage, independent of whether an invited account has a personal Agent.
CREATE TABLE app_member_account_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (user_id, day));
CREATE TABLE app_member_usage_counters (user_id TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (user_id, source));
