import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `conversations` group's handlers, empty until lane C moves its conversation RPC methods here the way
 * `topics/api.ts` does.
 */
export const ConversationsHandlers = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) => handlers)
