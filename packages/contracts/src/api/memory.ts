import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** The memory of a chat's Conversation (ADR 0032). Endpoints are added the way `topics.ts` adds them. */
export class MemoryGroup extends HttpApiGroup.make('memory') {}
