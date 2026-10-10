import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import {
  RoutineEdit,
  RoutineManualRun,
  RoutinePage,
  RoutineProposal,
  RoutineRevision,
  RoutineRunPage,
  RoutineRunView,
  RoutineSettings,
  RoutineView,
} from '../routines.ts'
import { ApiErrors } from './errors.ts'

/** A routine's id in a path, as the route has always taken it: `rt_` and up to 100 word characters or dashes. */
const RoutineParam = Schema.String.check(Schema.isPattern(/^rt_[\w-]{1,100}$/u))
const params = { id: RoutineParam }

/**
 * The owner's routines (ADR 0012). Paths are relative to the API's `/api` prefix; every endpoint can also answer
 * owner admission's failures, and `error` names the ones the endpoint itself produces. Every change carries the revision it
 * was made against and an operation id: a stale revision is a conflict, and the same operation answers the same result.
 *
 * - `list`: `GET /api/routines`, every routine but the archived ones.
 * - `propose`: `POST /api/routines`, 201 with the draft; it runs only once the owner confirms it.
 * - `settings`, `updateSettings`: `GET`/`PUT /api/routines/settings`, the timezone and the active and running caps.
 * - `edit`: `PATCH /api/routines/:id`, a new revision back in draft.
 * - `archive`: `DELETE /api/routines/:id` with the revision; its live runs stop.
 * - `confirm`, `pause`: `POST /api/routines/:id/confirm|pause` with the revision.
 * - `run`: `POST /api/routines/:id/run`, 202 with the run it admitted (or skipped).
 * - `runs`: `GET /api/routines/:id/runs`, its newest runs.
 */
export class RoutinesGroup extends HttpApiGroup.make('routines').add(
  HttpApiEndpoint.get('list', '/routines', { success: RoutinePage }),
  HttpApiEndpoint.post('propose', '/routines', {
    payload: RoutineProposal,
    success: RoutineView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('settings', '/routines/settings', { success: RoutineSettings }),
  HttpApiEndpoint.put('updateSettings', '/routines/settings', {
    payload: RoutineSettings,
    success: RoutineSettings,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.patch('edit', '/routines/:id', {
    params,
    payload: RoutineEdit,
    success: RoutineView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.delete('archive', '/routines/:id', {
    params,
    payload: RoutineRevision,
    success: RoutineView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('confirm', '/routines/:id/confirm', {
    params,
    payload: RoutineRevision,
    success: RoutineView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('pause', '/routines/:id/pause', {
    params,
    payload: RoutineRevision,
    success: RoutineView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('run', '/routines/:id/run', {
    params,
    payload: RoutineManualRun,
    success: RoutineRunView.pipe(HttpApiSchema.status(202)),
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.get('runs', '/routines/:id/runs', {
    params,
    success: RoutineRunPage,
    error: [ApiErrors.notFound],
  }),
) {}
