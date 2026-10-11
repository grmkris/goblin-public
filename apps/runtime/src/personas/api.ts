import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { requirePlan } from '../billing/gates.ts'
import { Resident } from '../mcp/service.ts'
import { resumePersona } from './ask.ts'
import { createPersona, personaDetail, updatePersona } from './program.ts'

/**
 * The `personas` group (ADR 0033): each handler runs its program as the owner. Owner admission has already admitted
 * the request; a reply to a Persona's hold (ADR 0041) is admitted again as an owner message is.
 */
export const PersonasHandlers = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
  handlers
    .handle('create', ({ payload }) => createPersona(payload, { actor: 'owner' }))
    .handle('detail', ({ params }) => personaDetail(params.id))
    .handle('update', ({ params, payload }) => updatePersona(params.id, payload, { actor: 'owner' }))
    .handle('reply', ({ payload }) =>
      Effect.gen(function* () {
        // The reply makes the Persona work again: the same admission an owner message gets.
        yield* requirePlan()
        yield* Resident.use((resident) => resident.renew())
        yield* resumePersona(payload.fork, payload.operationId, payload.text)
        return null
      }),
    ),
)
