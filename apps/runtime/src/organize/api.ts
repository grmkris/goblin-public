import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { undoReceipt } from './program.ts'

/**
 * The `organize` group (ADR 0033): each handler runs the program its Durable Object RPC method ran
 * (`organize/rpc.ts`). Undoing a Topic's creation archives it, which stops its chats' work as the owner's Stop does.
 */
export const OrganizeHandlers = HttpApiBuilder.group(OwnerApi, 'organize', (handlers) =>
  handlers.handle('undo', ({ params }) => undoReceipt(params.id)),
)
