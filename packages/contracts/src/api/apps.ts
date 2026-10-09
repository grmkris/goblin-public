import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The owner's kept Apps (ADR 0020): keep one from a call, close or reopen it, and an agent app view's state, calls and
 * errors. Endpoints are added the way `topics.ts` adds them.
 */
export class AppsGroup extends HttpApiGroup.make('apps') {}
