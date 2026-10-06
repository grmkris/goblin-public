/** Names emitted by Agents and Pi Durable in the pinned native spike. */
const VENDOR_TABLES = new Set([
  'cf_agent_tool_runs',
  'cf_agents_facet_runs',
  'cf_agents_fibers',
  'cf_agents_jobs',
  'cf_agents_mcp_servers',
  'cf_agents_runs',
  'cf_agents_state',
  'cf_agents_sub_agents',
  'cf_agents_task_runs',
  'cf_agents_task_steps',
  'cf_agents_workflows',
  'cf_agents_stream_blocks',
  'cf_agents_streams',
  'pi_conversations',
  'pi_document_revisions',
  'pi_documents',
  'pi_durable_metadata',
  'pi_durable_schema',
  'pi_entries',
  'pi_record_ids',
  'pi_submissions',
  'pi_tasks',
  '_cf_KV',
  '_cf_METADATA',
])

/** `@cloudflare/shell`'s file tables: `cf_workspace_<namespace>` and their indexes (the owner's files, ADR 0022). */
const SHELL_PREFIX = 'cf_workspace_'

export function isVendorTable(name: string): boolean {
  return (
    VENDOR_TABLES.has(name) ||
    name.startsWith('pi_') ||
    name.startsWith('cf_agent') ||
    name.startsWith(SHELL_PREFIX) ||
    name.startsWith('_cf_') ||
    name.startsWith('__drizzle')
  )
}

export type TableDefinition = { readonly name: string; readonly definition: string | null }

/** Read schema names only; platform-owned rows such as `_cf_KV` are intentionally opaque. */
export function listTables(storage: DurableObjectStorage): readonly TableDefinition[] {
  return storage.sql
    .exec<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .toArray()
    .map(({ name, sql }) => ({ name, definition: sql }))
}

export function assertApplicationTable(name: string): void {
  if (isVendorTable(name)) throw new Error(`application migration attempted vendor table: ${name}`)
  if (!name.startsWith('app_')) throw new Error(`application table must use app_ prefix: ${name}`)
}
