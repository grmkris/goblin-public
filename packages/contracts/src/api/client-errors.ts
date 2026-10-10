import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { ClientErrorReport } from '../account.ts'
import { API_ERRORS } from './errors.ts'

/**
 * Crash reports from the browser, content-free (ADR 0024), served by the Worker. Paths are relative to the API's `/api`
 * prefix.
 *
 * - `report`: `POST /api/client-errors`, 204. It needs the app's Origin and the CSRF header but no session, so a crash
 *   on the sign-in page is reported too. The report is logged, never stored.
 */
export class ClientErrorsGroup extends HttpApiGroup.make('clientErrors').add(
  HttpApiEndpoint.post('report', '/client-errors', {
    payload: ClientErrorReport,
    success: HttpApiSchema.NoContent,
    error: API_ERRORS,
  }),
) {}
