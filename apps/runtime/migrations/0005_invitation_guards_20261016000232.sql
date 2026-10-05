ALTER TABLE app_workspace_members ADD COLUMN last_operation_id TEXT;
ALTER TABLE app_workspace_invitations ADD COLUMN last_operation_id TEXT;
CREATE TABLE app_workspace_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
