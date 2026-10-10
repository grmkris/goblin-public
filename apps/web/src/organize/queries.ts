import { owner } from '../lib/api.ts'

/** Organizing on the owner API. The workspace feed carries the receipts and the Topics an undo changes. */

/** Undo of receipt `id`: its target goes back as it was. */
export const undoMutation = owner.apiMutation({
  mutationFn: (api, id: string) => api.organize.undo({ params: { id } }),
})
