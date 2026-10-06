-- One MCP endpoint (ADR 0024, amended 2026-10-06). Every registered client may now ask for read-only inspection
-- (`goblin:inspect`) on /mcp; the owner's consent still decides. The withdrawn operator scope and the retired
-- /mcp/inspect and /mcp/operator resources go, with their client links.
UPDATE "oauthClient"
SET "scopes" = (
  SELECT json_group_array("value") FROM (
    SELECT "value" FROM json_each("oauthClient"."scopes") WHERE "value" NOT IN ('goblin:inspect', 'goblin:operator')
    UNION ALL
    SELECT 'goblin:inspect'
  )
)
WHERE "scopes" IS NOT NULL AND json_valid("scopes");
DELETE FROM "oauthClientResource" WHERE "resourceId" LIKE '%/mcp/inspect' OR "resourceId" LIKE '%/mcp/operator';
DELETE FROM "oauthResource" WHERE "identifier" LIKE '%/mcp/inspect' OR "identifier" LIKE '%/mcp/operator';
