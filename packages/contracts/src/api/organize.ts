import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { OrganizeReceipt } from '../topics.ts'
import { ApiErrors } from './errors.ts'

/** A receipt's id in a path: `org_` and 32 lowercase hex digits. */
const ReceiptParam = Schema.String.check(Schema.isPattern(/^org_[0-9a-f]{32}$/u))

/**
 * Undo for one organizing change (ADR 0033); the workspace feed carries the receipts. Paths are relative to the API's `/api` prefix.
 *
 * - `undo`: `POST /api/organize/:id/undo` puts the target back as it was before the change. It is a conflict once
 *   anything changed the target since (`touched`) and once the receipt is undone (`undone`); restoring a name another
 *   active Topic or Persona took since is a conflict too.
 */
export class OrganizeGroup extends HttpApiGroup.make('organize').add(
  HttpApiEndpoint.post('undo', '/organize/:id/undo', {
    params: { id: ReceiptParam },
    success: OrganizeReceipt,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
) {}
