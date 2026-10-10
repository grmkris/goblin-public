import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Inspection } from './service.ts'

/**
 * The `inspect` group (ADR 0024). Owner admission has already admitted the request. `details` reads the operation
 * behind one message of the chat: the one the query names, or the one whose answer or tool result the entry is.
 */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) =>
  handlers.handle('details', ({ params, query }) =>
    Inspection.use((inspection) =>
      inspection.details('operation' in query ? query : { chat: params.id, entry: query.entry }),
    ),
  ),
)
