import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `agentApps` group's handlers, empty until lane A moves its agent app RPC methods here the way `topics/api.ts`
 * does.
 */
export const AgentAppsHandlers = HttpApiBuilder.group(OwnerApi, 'agentApps', (handlers) => handlers)
