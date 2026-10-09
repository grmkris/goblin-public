import type { CreateTopic, UpdateTopic } from '@goblin/contracts'
import { type QueryClient, mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { withOperation } from '../lib/query/api-query.ts'

/** Every Topic read: keys are `['topics', kind, input]`. The workspace feed carries the Topics themselves. */
export const topicKeys = { all: ['topics'] as const }

/** A new Topic; the same `operationId` finds the same one. */
export const createTopicMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, topic: CreateTopic) =>
        api.topics.create({ payload: topic }).pipe(withOperation(topic.operationId)),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: topicKeys.all }),
  })

/** A Topic renamed, archived or restored, or kept out of search. */
export const updateTopicMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, { id, change }: { readonly id: number; readonly change: UpdateTopic }) =>
        api.topics.update({ params: { id }, payload: change }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: topicKeys.all }),
  })
