import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { NotificationsRead } from '../notices.ts'

/**
 * The owner's notifications (ADR 0041); the workspace feed carries them. Paths are relative to the API's `/api` prefix.
 *
 * - `read`: `POST /api/notices/read` marks notifications read from Activity. Opening their chat reads them too.
 */
export class NoticesGroup extends HttpApiGroup.make('notices').add(
  HttpApiEndpoint.post('read', '/notices/read', { payload: NotificationsRead, success: Schema.Null }),
) {}
