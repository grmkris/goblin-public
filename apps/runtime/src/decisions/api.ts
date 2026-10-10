import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Decisions } from './service.ts'

/** The `decisions` group (ADR 0031): the owner's label of a proposal. The workspace feed carries the proposals. */
export const DecisionsHandlers = HttpApiBuilder.group(OwnerApi, 'decisions', (handlers) =>
  handlers.handle('label', ({ params, payload }) =>
    Decisions.use((decisions) => decisions.label(params.id, payload.label)),
  ),
)
