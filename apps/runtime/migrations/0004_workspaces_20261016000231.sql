CREATE TABLE app_agent_workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
  access_version INTEGER NOT NULL DEFAULT 1,
  deletion_phase TEXT CHECK (deletion_phase IS NULL OR deletion_phase IN ('pending', 'destroyed')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE app_workspace_members (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES app_agent_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('active', 'removed')), policy_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, invitation_id TEXT, joined_at INTEGER NOT NULL, removed_at INTEGER,
  UNIQUE (workspace_id, user_id)
);
CREATE UNIQUE INDEX app_workspace_one_owner ON app_workspace_members(workspace_id) WHERE role = 'owner';
CREATE INDEX app_workspace_members_user ON app_workspace_members(user_id, state);
CREATE TABLE app_workspace_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES app_agent_workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('member', 'viewer')), policy_json TEXT NOT NULL,
  secret_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  send_state TEXT NOT NULL CHECK (send_state IN ('pending', 'sent', 'failed')),
  version INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL, accepted_user_id TEXT,
  accepted_member_id TEXT, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, operation_id)
);
CREATE UNIQUE INDEX app_workspace_pending_invite ON app_workspace_invitations(workspace_id, email) WHERE state = 'pending';
CREATE INDEX app_workspace_invite_email ON app_workspace_invitations(email, state, expires_at);
CREATE TABLE app_invite_admissions (
  proof_hash TEXT PRIMARY KEY NOT NULL,
  invitation_id TEXT NOT NULL REFERENCES app_workspace_invitations(id) ON DELETE CASCADE,
  invitation_version INTEGER NOT NULL, email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'used', 'revoked')), expires_at INTEGER NOT NULL
);
CREATE TABLE app_workspace_sessions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES app_agent_workspaces(id) ON DELETE CASCADE,
  context TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE app_account_admissions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ordinary', 'invitation')), created_at INTEGER NOT NULL
);
CREATE TABLE app_workspace_audit (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES app_agent_workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL,
  operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, operation_id)
);
-- Add metadata only: existing agents retain their exact owner user id, SQLite and Pi history.
INSERT INTO app_account_admissions (user_id, kind, created_at)
SELECT id, 'ordinary', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM user;
INSERT INTO app_agent_workspaces (id, owner_user_id, name, state, access_version, created_at, updated_at)
SELECT 'ws_' || lower(hex(randomblob(16))), id, substr(name, 1, 80) || '''s agent', 'active', 1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM user;
INSERT INTO app_workspace_members (id, workspace_id, user_id, role, state, policy_json, version, joined_at)
SELECT 'own_' || id, id, owner_user_id, 'owner', 'active', '{"servers":[],"skills":[],"mainHistory":"all"}', 1, created_at
FROM app_agent_workspaces;
