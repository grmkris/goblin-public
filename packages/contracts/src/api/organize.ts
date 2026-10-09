import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** What organizing changed (ADR 0033), and Undo for one change. Endpoints are added the way `topics.ts` adds them. */
export class OrganizeGroup extends HttpApiGroup.make('organize') {}
