import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import {
  AppCall,
  AppCallResult,
  AppDiagnostic,
  AppDiagnosticResult,
  AppLaunch,
  AppSnapshot,
  AppView,
  CreateApp,
  UpdateApp,
} from '../index.ts'
import { ApiErrors } from './errors.ts'

/** An App's id in a path, as the route has always taken it: 1 to 12 digits. */
const AppParam = { id: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)) }

/**
 * The owner's kept Apps (ADRs 0020, 0021). Paths are relative to the API's `/api` prefix; `error` names the failures
 * each endpoint produces itself, besides the owner gate's.
 *
 * - `create`: `POST /api/apps`, 201 with the App kept from a tool call in one of the owner's conversations (one from
 *   before Apps were kept, or one the owner closed). The same call keeps the same App. Its server must still render it.
 * - `launch`: `GET /api/apps/:id/launch`, what the browser loads it with. It grants nothing; its calls are checked live.
 * - `update`: `PATCH /api/apps/:id` closes the App or opens it again.
 * - `state`, `call`, `diagnostics`: an agent app's view reads its state, calls one of its actions with the frame's
 *   operation id (the state after it, or the app's own error), and reports its failures, kept where the agent sees them.
 */
export class AppsGroup extends HttpApiGroup.make('apps').add(
  HttpApiEndpoint.post('create', '/apps', {
    payload: CreateApp,
    success: AppView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.upstream, ApiErrors.upstreamTimeout],
  }),
  HttpApiEndpoint.get('launch', '/apps/:id/launch', {
    params: AppParam,
    success: AppLaunch,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.patch('update', '/apps/:id', {
    params: AppParam,
    payload: UpdateApp,
    success: AppView,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('state', '/apps/:id/state', {
    params: AppParam,
    success: AppSnapshot,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.post('call', '/apps/:id/call', {
    params: AppParam,
    payload: AppCall,
    success: AppCallResult,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.post('diagnostics', '/apps/:id/diagnostics', {
    params: AppParam,
    payload: AppDiagnostic,
    success: AppDiagnosticResult,
    error: [ApiErrors.notFound],
  }),
) {}
