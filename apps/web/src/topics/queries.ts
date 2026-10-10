import type { CreateTopic, UpdateTopic } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { withOperation } from '../lib/query/api-query.ts'

/** The owner's Topics on the owner API. The workspace feed carries the Topics themselves, so a change reads nothing. */

/** A new Topic; the same `operationId` finds the same one. */
export const createTopicMutation = owner.apiMutation({
  mutationFn: (api, topic: CreateTopic) => api.topics.create({ payload: topic }).pipe(withOperation(topic.operationId)),
})

/** A Topic renamed, archived or restored, or kept out of search. */
export const updateTopicMutation = owner.apiMutation({
  mutationFn: (api, { id, change }: { readonly id: number; readonly change: UpdateTopic }) =>
    api.topics.update({ params: { id }, payload: change }),
})
