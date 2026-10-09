import { type QueryClient, mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { topicKeys } from '../topics/queries.ts'

/** Every organizing read: keys are `['organize', kind, input]`. The workspace feed carries the receipts themselves. */
export const organizeKeys = { all: ['organize'] as const }

/** Undo of receipt `id`: its target goes back as it was, so its receipts and Topics read again. */
export const undoMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, id: string) => api.organize.undo({ params: { id } }) }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: organizeKeys.all }),
        queryClient.invalidateQueries({ queryKey: topicKeys.all }),
      ]),
  })
