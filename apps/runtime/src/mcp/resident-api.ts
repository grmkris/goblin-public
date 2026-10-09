import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `resident` group's handlers, empty until lane M moves its resident authority RPC methods here the way
 * `topics/api.ts` does.
 */
export const ResidentHandlers = HttpApiBuilder.group(OwnerApi, 'resident', (handlers) => handlers)
