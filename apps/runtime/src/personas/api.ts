import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { createPersona, personaDetail, updatePersona } from './program.ts'

/**
 * The `personas` group (ADR 0033): each handler runs the program its Durable Object RPC method ran before the typed
 * API replaced them, as the owner. The owner gate has already admitted the request.
 */
export const PersonasHandlers = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
  handlers
    .handle('create', ({ payload }) => createPersona(payload, { actor: 'owner' }))
    .handle('detail', ({ params }) => personaDetail(params.id))
    .handle('update', ({ params, payload }) => updatePersona(params.id, payload, { actor: 'owner' })),
)
