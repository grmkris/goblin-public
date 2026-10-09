import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * Crash reports from the browser, content-free, served by the Worker. Endpoints are added the way `topics.ts` adds
 * them.
 */
export class ClientErrorsGroup extends HttpApiGroup.make('clientErrors') {}
