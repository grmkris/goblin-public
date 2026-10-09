import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChatId, EntryId, OperationId } from '../ids.ts'
import { InspectDetails } from '../inspect.ts'
import { ApiErrors } from './errors.ts'

/** Which message of the chat: the operation that sent it, or the entry it shows as. */
const DetailsQuery = Schema.Union([Schema.Struct({ operation: OperationId }), Schema.Struct({ entry: EntryId })])

/**
 * Read-only inspection of the agent's conversations and runs (ADR 0024) for the owner's own UI. Paths are relative to
 * the API's `/api` prefix; /mcp's inspection tools read the same through the agent's raw `/inspect` route.
 *
 * - `details`: `GET /api/conversations/:id/details?operation=…` or `?entry=…`, what happened behind one message of the
 *   chat: the timeline of its operation (its turn when it ran one) and the operations related to it. The path sits
 *   with the conversation routes, whose `:id` is the chat id; the endpoint belongs to inspection.
 */
export class InspectGroup extends HttpApiGroup.make('inspect').add(
  HttpApiEndpoint.get('details', '/conversations/:id/details', {
    params: { id: ChatId },
    query: DetailsQuery,
    success: InspectDetails,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
) {}
