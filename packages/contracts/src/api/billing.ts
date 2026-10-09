import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** The account's plan and checkout, served by the Worker. Endpoints are added the way `topics.ts` adds them. */
export class BillingGroup extends HttpApiGroup.make('billing') {}
