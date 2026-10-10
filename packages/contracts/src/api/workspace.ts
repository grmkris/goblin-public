import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { RenewsResident } from './resident.ts'
import { EventStream } from './stream.ts'

/**
 * The owner's workspace as one live feed. Paths are relative to the API's `/api` prefix; it does not renew resident
 * authority.
 *
 * - `events`: `GET /api/workspace/events`, server-sent: `event: snapshot` with every conversation, App, Topic, Persona
 *   and organizing receipt as it is now, then `event: change` batches as they happen. It stays open until the browser
 *   goes away.
 */
export class WorkspaceGroup extends HttpApiGroup.make('workspace')
  .add(HttpApiEndpoint.get('events', '/workspace/events', { success: EventStream }))
  .annotateEndpoints(RenewsResident, false) {}
