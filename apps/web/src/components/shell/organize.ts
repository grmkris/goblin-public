import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TopicView, UpdateTopic } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import { messageOf } from '../../lib/query/app-error.ts'
import { undoMutation } from '../../organize/queries.ts'
import { createTopicMutation, updateTopicMutation } from '../../topics/queries.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

/** Why an Undo was refused, in words: something changed the target since, or it was already undone. */
export function undoRefusal(failure: unknown): string {
  if (failure instanceof Conflict && failure.reason === 'touched') return 'Changed since, so it cannot be undone.'
  if (failure instanceof Conflict && failure.reason === 'undone') return 'Already undone.'
  return messageOf(failure, 'undo it')
}

/**
 * The owner's organizing: create a Topic (the same `operationId` finds the same one), rename, archive, restore or
 * exclude one from search, and undo a receipt. Each shows what the server answered at once; the feed confirms it. They
 * throw what the server refused (a name in use, a Personal that cannot be archived).
 */
export function useOrganize() {
  const queryClient = useQueryClient()
  const { apply } = useWorkspaceFeed()
  const create = useMutation(createTopicMutation(queryClient)).mutateAsync
  const update = useMutation(updateTopicMutation(queryClient)).mutateAsync
  const undo = useMutation(undoMutation(queryClient)).mutateAsync
  return useMemo(
    () => ({
      createTopic: async (name: string, operationId: string): Promise<TopicView> => {
        const topic = await create({ name, operationId })
        apply([{ type: 'topic', topic }])
        return topic
      },
      updateTopic: async (id: number, change: UpdateTopic): Promise<TopicView> => {
        const topic = await update({ id, change })
        apply([{ type: 'topic', topic }])
        return topic
      },
      undo: async (receipt: string): Promise<void> => {
        apply([{ type: 'receipt', receipt: await undo(receipt) }])
      },
    }),
    [apply, create, update, undo],
  )
}
