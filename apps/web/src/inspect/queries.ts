import { owner } from '../lib/api.ts'

/** Every inspection read: keys are `['inspect', kind, …input]`. */
const inspectKeys = { details: (chat: string, entry: number) => ['inspect', 'details', chat, entry] as const }

/**
 * What happened behind message `entry` of chat `chat` (ADR 0024): the timeline of the operation that wrote it (its turn,
 * when it ran one), and the operations related to it.
 */
export const detailsQuery = (chat: string, entry: number) =>
  owner.apiQuery({
    queryKey: inspectKeys.details(chat, entry),
    queryFn: (api) => api.inspect.details({ params: { id: chat }, query: { entry } }),
  })
