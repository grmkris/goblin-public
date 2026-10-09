import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `routines` group's handlers, empty until lane R moves its routine RPC methods here the way `topics/api.ts` does.
 */
export const RoutinesHandlers = HttpApiBuilder.group(OwnerApi, 'routines', (handlers) => handlers)
