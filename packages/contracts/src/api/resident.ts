import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * Resident authority: its status, and revoking or re-enabling it. Endpoints are added the way `topics.ts` adds them.
 */
export class ResidentGroup extends HttpApiGroup.make('resident') {}
