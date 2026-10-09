import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/** The `mcp` group's handlers, empty until lane M moves its MCP RPC methods here the way `topics/api.ts` does. */
export const McpHandlers = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) => handlers)
