import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `organize` group's handlers, empty until lane D moves its receipt and Undo RPC methods here the way
 * `topics/api.ts` does.
 */
export const OrganizeHandlers = HttpApiBuilder.group(OwnerApi, 'organize', (handlers) => handlers)
