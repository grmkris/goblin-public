import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `agent` group's handlers, empty until lane R moves its usage, model and channel RPC methods here the way
 * `topics/api.ts` does.
 */
export const AgentHandlers = HttpApiBuilder.group(OwnerApi, 'agent', (handlers) => handlers)
