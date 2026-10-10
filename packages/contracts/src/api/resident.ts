import * as Context from 'effect/Context'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ResidentStatus } from '../agent.ts'
import { ResidentChange } from '../mcp.ts'

/**
 * Whether owner admission renews resident authority before the endpoint runs (`OwnerAdmission` in `owner.ts`). Every owner
 * request renews it except changing it: a revocation must not renew first, and re-enabling renews on its own. An
 * endpoint that must not renew is annotated `false`; admission still checks the plan.
 */
export const RenewsResident = Context.Reference<boolean>('goblin/api/RenewsResident', { defaultValue: () => true })

/**
 * Resident authority (ADR 0003): what lets the agent act without a live browser session. Paths are relative to the
 * API's `/api` prefix.
 *
 * - `status`: `GET /api/agent/resident`, as it is now, after admission renewed it.
 * - `set`: `POST /api/agent/resident` revokes it (Events subscriptions first) or enables it again; admission does not
 *   renew it first.
 */
export class ResidentGroup extends HttpApiGroup.make('resident').add(
  HttpApiEndpoint.get('status', '/agent/resident', { success: ResidentStatus }),
  HttpApiEndpoint.post('set', '/agent/resident', { payload: ResidentChange, success: ResidentStatus }).annotate(
    RenewsResident,
    false,
  ),
) {}
