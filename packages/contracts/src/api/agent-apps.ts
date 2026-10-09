import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { AgentAppChange, AgentAppDeleted, AgentAppDetail, AgentAppSummary, DeleteAgentApp } from '../index.ts'
import { ApiErrors } from './errors.ts'

/** An agent app's name in a path, as the route has always taken it: kebab-case, 2 to 24 characters. */
const NameParam = { name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,23}$/u)) }

/**
 * The owner's agent apps (ADR 0021), by name. Paths are relative to the API's `/api` prefix; `error` names the failures
 * each endpoint produces itself, besides the owner gate's.
 *
 * - `list`: `GET /api/agent-apps`, every agent app, newest change first, each with its App id once it has a view.
 * - `detail`: `GET /api/agent-apps/:name`, one in full.
 * - `change`: `POST /api/agent-apps/:name` rolls it back, pauses or resumes a schedule, runs one now, moves its home to
 *   another open conversation of the owner's own, or answers a power; the app as it is after the change.
 * - `delete`: `DELETE /api/agent-apps/:name` erases it, its schedules, files and App, once the owner types its name.
 */
export class AgentAppsGroup extends HttpApiGroup.make('agentApps').add(
  HttpApiEndpoint.get('list', '/agent-apps', { success: Schema.Array(AgentAppSummary) }),
  HttpApiEndpoint.get('detail', '/agent-apps/:name', {
    params: NameParam,
    success: AgentAppDetail,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.post('change', '/agent-apps/:name', {
    params: NameParam,
    payload: AgentAppChange,
    success: AgentAppDetail,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.conflict],
  }),
  HttpApiEndpoint.delete('delete', '/agent-apps/:name', {
    params: NameParam,
    payload: DeleteAgentApp,
    success: AgentAppDeleted,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
) {}
