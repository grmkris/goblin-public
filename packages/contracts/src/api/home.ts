import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { HomeEdit, HomeEditResult, HomeRead, HomeStale } from '../home.ts'
import { ApiErrors } from './errors.ts'

const [Applied, , OwnerRequired] = HomeEditResult.members

/**
 * The owner's Home surface: its saved layout and the edits that arrange it. Paths are relative to the API's `/api`
 * prefix.
 *
 * - `read`: `GET /api/home`, the layout and the agent apps that can be placed on it.
 * - `edit`: `POST /api/home`, one atomic ordered edit, or the owner's Undo of one (`undoOf`). The same operation id
 *   answers what it answered the first time. An edit of an older revision is refused as `HomeStale`, with 409 and the
 *   body it has always had; as a refusal rather than a result, a client tells it from a conflict's 409 by its shape. An
 *   Undo after a later edit is a conflict.
 */
export class HomeGroup extends HttpApiGroup.make('home').add(
  HttpApiEndpoint.get('read', '/home', { success: HomeRead }),
  HttpApiEndpoint.post('edit', '/home', {
    payload: HomeEdit,
    success: Schema.Union([Applied, OwnerRequired]),
    error: [
      HomeStale.pipe(HttpApiSchema.status(409)),
      ApiErrors.conflict,
      ApiErrors.invalidInput,
      ApiErrors.forbidden,
      ApiErrors.notFound,
    ],
  }),
) {}
