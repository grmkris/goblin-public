import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TopicView, UpdateTopic } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import { messageOf } from '../../lib/query/app-error.ts'
import { withRef } from '../../lib/refusal.ts'
import { applyWorkspaceChanges } from '../../lib/workspace/sync.ts'
import { undoMutation } from '../../organize/queries.ts'
import { createTopicMutation, updateTopicMutation } from '../../topics/queries.ts'

/** Why an Undo was refused, in words: something changed the target since, or it was already undone. */
export function undoRefusal(failure: unknown): string {
  if (failure instanceof Conflict && failure.reason === 'touched')
    return withRef('Changed since, so it cannot be undone.', failure)
  if (failure instanceof Conflict && failure.reason === 'undone') return withRef('Already undone.', failure)
  return messageOf(failure, 'undo it')
}

/**
 * The owner's organizing: create a Topic (the same `operationId` finds the same one), rename, archive, restore or
 * exclude one from search, and undo a receipt. Each shows what the server answered at once; the feed confirms it. They
 * throw what the server refused (a name in use, a Personal that cannot be archived).
 */
export function useOrganize() {
  const queryClient = useQueryClient()
  const create = useMutation(createTopicMutation).mutateAsync
  const update = useMutation(updateTopicMutation).mutateAsync
  const undo = useMutation(undoMutation).mutateAsync
  return useMemo(
    () => ({
      createTopic: async (name: string, operationId: string): Promise<TopicView> => {
        const topic = await create({ name, operationId })
        applyWorkspaceChanges(queryClient, [{ type: 'topic', topic }])
        return topic
      },
      updateTopic: async (id: number, change: UpdateTopic): Promise<TopicView> => {
        const topic = await update({ id, change })
        applyWorkspaceChanges(queryClient, [{ type: 'topic', topic }])
        return topic
      },
      undo: async (receipt: string): Promise<void> => {
        applyWorkspaceChanges(queryClient, [{ type: 'receipt', receipt: await undo(receipt) }])
      },
    }),
    [queryClient, create, update, undo],
  )
}
