import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Memories } from './service.ts'

/**
 * The `memory` group (ADR 0032): `status` answers the memory of the Conversation a chat sits under. Owner admission
 * has already admitted the request.
 */
export const MemoryHandlers = HttpApiBuilder.group(OwnerApi, 'memory', (handlers) =>
  handlers.handle('status', ({ query }) => Memories.use((memories) => memories.status(query.chat))),
)
