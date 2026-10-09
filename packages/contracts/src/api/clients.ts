import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { InboundClient } from '../index.ts'
import { API_ERRORS } from './errors.ts'

/** A registered client's id in a path, as the route has always taken it. */
const ClientId = Schema.String.check(Schema.isPattern(/^[\w.-]{1,200}$/u))

/**
 * The MCP clients the owner let use their agent (ADR 0024), served by the Worker for an account with a plan. Paths are
 * relative to the API's `/api` prefix. Each can answer any `AppError` envelope (`API_ERRORS`), the edge's admission
 * refusals among them.
 *
 * - `list`: `GET /api/clients`, every client with a standing consent, newest first.
 * - `revoke`: `DELETE /api/clients/:clientId` ends that client's access at once: its consent goes and its refresh
 *   tokens are revoked. Other accounts that use the same client keep theirs.
 */
export class ClientsGroup extends HttpApiGroup.make('clients').add(
  HttpApiEndpoint.get('list', '/clients', { success: Schema.Array(InboundClient), error: API_ERRORS }),
  HttpApiEndpoint.delete('revoke', '/clients/:clientId', {
    params: { clientId: ClientId },
    success: Schema.Struct({ revoked: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}
