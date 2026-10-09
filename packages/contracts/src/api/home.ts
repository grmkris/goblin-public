import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** The owner's Home surface. Endpoints are added the way `topics.ts` adds them. */
export class HomeGroup extends HttpApiGroup.make('home') {}
