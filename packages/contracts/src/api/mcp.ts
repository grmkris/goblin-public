import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The owner's MCP servers: catalog, registries, grants, approvals and each server's actions. Endpoints are added the
 * way `topics.ts` adds them.
 */
export class McpGroup extends HttpApiGroup.make('mcp') {}
