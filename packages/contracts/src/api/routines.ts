import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** The owner's routines: proposals, edits, runs and settings. Endpoints are added the way `topics.ts` adds them. */
export class RoutinesGroup extends HttpApiGroup.make('routines') {}
