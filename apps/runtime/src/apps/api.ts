import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  agentAppSnapshot,
  callAgentApp,
  createOwnerApp,
  launchOwnerApp,
  reportAgentApp,
  updateOwnerApp,
} from './program.ts'

/**
 * The `apps` group (ADRs 0020, 0021): each handler runs the program its Durable Object RPC method ran. The owner gate
 * has already admitted the request, and a program's `AppError` is answered in its envelope.
 */
export const AppsHandlers = HttpApiBuilder.group(OwnerApi, 'apps', (handlers) =>
  handlers
    .handle('create', ({ payload }) => createOwnerApp(payload))
    .handle('launch', ({ params }) => launchOwnerApp(params.id))
    .handle('update', ({ params, payload }) => updateOwnerApp(params.id, payload))
    .handle('state', ({ params }) => agentAppSnapshot(params.id))
    .handle('call', ({ params, payload }) => callAgentApp(params.id, payload))
    .handle('diagnostics', ({ params, payload }) => reportAgentApp(params.id, payload)),
)
