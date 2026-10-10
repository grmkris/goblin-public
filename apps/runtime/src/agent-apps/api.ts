import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { agentAppDetail, agentAppList, changeAgentApp, deleteAgentApp } from '../apps/program.ts'

/**
 * The `agentApps` group (ADR 0021): each handler runs its program. Owner admission has already admitted the request,
 * and a program's `AppError` is answered in its envelope.
 */
export const AgentAppsHandlers = HttpApiBuilder.group(OwnerApi, 'agentApps', (handlers) =>
  handlers
    .handle('list', () => agentAppList)
    .handle('detail', ({ params }) => agentAppDetail(params.name))
    .handle('change', ({ params, payload }) => changeAgentApp(params.name, payload))
    .handle('delete', ({ params, payload }) => deleteAgentApp(params.name, payload)),
)
