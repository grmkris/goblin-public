import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The agent itself: today's usage, its model, and its Telegram channel. Endpoints are added the way `topics.ts` adds
 * them.
 */
export class AgentGroup extends HttpApiGroup.make('agent') {}
