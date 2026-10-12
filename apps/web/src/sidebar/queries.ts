// The owner's sidebar pins (ADR 0053) through the owner's typed client. The pins themselves are read from the
// workspace feed (`useSidebarPins`), never on their own; an edit is answered with the pins as they are after it.
import type { SidebarEdit } from '@goblin/contracts'
import { owner } from '../lib/api.ts'

/** One pin, unpin or move against the revision the browser read: applied, or stale with the pins as they are. */
export const sidebarEditMutation = owner.apiMutation({
  mutationFn: (api, edit: SidebarEdit) => api.sidebar.edit({ payload: edit }),
})
