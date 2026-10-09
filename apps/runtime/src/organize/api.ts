import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { AgentInput } from '../runtime/input.ts'
import { receiptList, undoReceipt } from './program.ts'

/**
 * The `organize` group (ADR 0033): each handler runs the program its Durable Object RPC method ran
 * (`organize/rpc.ts`). Undo of a Topic archive or restore reaches what a Stop reaches, as the RPC method did.
 */
export const OrganizeHandlers = HttpApiBuilder.group(OwnerApi, 'organize', (handlers) =>
  handlers
    .handle('list', () => receiptList)
    .handle('undo', ({ params }) => AgentInput.use(({ stopping }) => undoReceipt(stopping(), params.id))),
)
