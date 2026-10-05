-- Dormant leftovers of Members (withdrawn 2026-10-05); retain applied tables and migration history.
CREATE TABLE app_member_invalidations (id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, member_id TEXT NOT NULL, member_version INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX app_pending_member_invalidations ON app_member_invalidations (state);
