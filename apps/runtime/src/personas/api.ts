import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `personas` group's handlers, empty until lane D moves its Persona RPC methods here the way `topics/api.ts` does.
 */
export const PersonasHandlers = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) => handlers)
