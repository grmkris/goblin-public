import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

/**
 * The `memory` group's handlers, empty until lane K moves its memory status RPC method here the way `topics/api.ts`
 * does.
 */
export const MemoryHandlers = HttpApiBuilder.group(OwnerApi, 'memory', (handlers) => handlers)
