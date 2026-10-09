import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The owner's conversations and threads: list, create, send, move, stop, queue, read, snapshot, history, sources,
 * capabilities and composer. Endpoints are added the way `topics.ts` adds them.
 */
export class ConversationsGroup extends HttpApiGroup.make('conversations') {}
