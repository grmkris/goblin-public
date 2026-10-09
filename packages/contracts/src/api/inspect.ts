import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * Read-only inspection of the agent's conversations and runs (ADR 0024). Endpoints are added the way `topics.ts` adds
 * them.
 */
export class InspectGroup extends HttpApiGroup.make('inspect') {}
