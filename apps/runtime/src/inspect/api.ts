import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { NotFound } from '../http/errors.ts'

/**
 * The `inspect` group (ADR 0024). The owner gate has already admitted the request. `details` finds nothing yet: a
 * message's operation, its passive writes and its related operations come from the operation receipts, which the
 * details reader does not read so far, so it answers `NotFound` rather than a partial timeline.
 */
export const InspectHandlers = HttpApiBuilder.group(OwnerApi, 'inspect', (handlers) =>
  handlers.handle('details', () => Effect.fail(new NotFound({ what: 'details' }))),
)
