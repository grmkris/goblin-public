import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/**
 * The owner's Personas (ADR 0033): list, create, one with its revisions, a new revision. Endpoints are added the way
 * `topics.ts` adds them.
 */
export class PersonasGroup extends HttpApiGroup.make('personas') {}
