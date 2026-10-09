import { useMemo } from 'react'
import { OrganizeReceipt, TopicView, type UpdateTopic } from '@goblin/contracts'
import { Schema } from 'effect'
import { ApiFailure, failureText, request } from '../../lib/boundary.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

const decodeTopic = Schema.decodeUnknownSync(TopicView)
const decodeReceipt = Schema.decodeUnknownSync(OrganizeReceipt)

/** Why an Undo was refused, in words: something changed the target since, or it was already undone. */
export function undoRefusal(failure: unknown): string {
  if (failure instanceof ApiFailure && failure.reason === 'touched') return 'Changed since, so it cannot be undone.'
  if (failure instanceof ApiFailure && failure.reason === 'undone') return 'Already undone.'
  return failureText(failure)
}

/**
 * The owner's organizing: create a Topic (the same `operationId` finds the same one), rename, archive, restore or
 * exclude one from search, and undo a receipt. Each shows what the server answered at once; the feed confirms it. They
 * throw what the server refused (a name in use, a Personal that cannot be archived).
 */
export function useOrganize() {
  const { apply } = useWorkspaceFeed()
  return useMemo(
    () => ({
      createTopic: async (name: string, operationId: string): Promise<TopicView> => {
        const topic = decodeTopic(await request('/api/topics', { body: { name, operationId } }))
        apply([{ type: 'topic', topic }])
        return topic
      },
      updateTopic: async (id: number, change: UpdateTopic): Promise<TopicView> => {
        const topic = decodeTopic(await request(`/api/topics/${id}`, { method: 'PATCH', body: change }))
        apply([{ type: 'topic', topic }])
        return topic
      },
      undo: async (receipt: string): Promise<void> => {
        const undone = decodeReceipt(await request(`/api/organize/${receipt}/undo`, { body: {} }))
        apply([{ type: 'receipt', receipt: undone }])
      },
    }),
    [apply],
  )
}
