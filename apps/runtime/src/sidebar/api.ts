import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Sidebar } from './service.ts'

/**
 * The `sidebar` group (ADR 0053): the owner's pins, and one change to them. Owner admission has already admitted the
 * request; pinning grants nothing, so nothing here needs resident authority.
 */
export const SidebarHandlers = HttpApiBuilder.group(OwnerApi, 'sidebar', (handlers) =>
  handlers
    .handle('read', () => Sidebar.use((sidebar) => sidebar.read))
    .handle('edit', ({ payload }) => Sidebar.use((sidebar) => sidebar.edit(payload))),
)
