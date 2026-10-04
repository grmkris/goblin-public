-- Purrable-owned D1 grant metadata. No Pi/Agents Durable Object vendor table is touched.
CREATE TABLE IF NOT EXISTS app_mcp_grant_generations (
  issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, server_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issuer, subject, client_id, server_id)
);
CREATE TABLE IF NOT EXISTS app_mcp_grants (
  issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, tenant_id TEXT,
  server_id TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('tool', 'resource', 'prompt')),
  name TEXT NOT NULL, scopes_json TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (issuer, subject, client_id, server_id, capability, name)
);
CREATE INDEX IF NOT EXISTS app_mcp_grants_current ON app_mcp_grants (issuer, subject, client_id, server_id, generation);
