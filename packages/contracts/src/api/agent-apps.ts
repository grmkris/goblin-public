import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The owner's agent apps (ADR 0021): the list, one in full, a change to one, and deleting one. Endpoints are added the
 * way `topics.ts` adds them.
 */
export class AgentAppsGroup extends HttpApiGroup.make('agentApps') {}
