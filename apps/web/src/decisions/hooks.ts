import type { EphemeralMessage } from '@goblin/contracts'
import { useMutation } from '@tanstack/react-query'
import { useMemo } from 'react'
import { AttachmentDraft } from '../lib/attachment-draft.ts'
import { useNavigation } from '../lib/navigation.ts'
import { useProposals } from '../lib/workspace/hooks.ts'
import { labelDecisionMutation } from './queries.ts'
import { labelOf, opensThread, proposalMessages } from './rows.ts'

/** The owner-only rows of each chat, and what the owner's choice on one does. */
export type DecisionRows = {
  /** The owner-only rows of a chat, oldest first. */
  readonly of: (chat: string) => readonly EphemeralMessage[]
  /** The owner chose one of a row's actions (its stable id, which the runtime understands). */
  readonly act: (message: EphemeralMessage, action: string) => void
  /** The owner dismissed a row. */
  readonly dismiss: (message: EphemeralMessage) => void
}

/**
 * The open decision proposals (ADR 0031) as the chats' "Only visible to you" rows. The owner's choice is kept as a
 * label (`labelDecisionMutation`); a confirmed "this could be a thread" then opens an empty new thread's draft in that
 * chat's channel. Nothing moves and nothing is sent on the owner's behalf.
 */
export function useDecisionRows(): DecisionRows {
  const rows = useProposals(proposalMessages)
  const { mutate } = useMutation(labelDecisionMutation)
  const navigation = useNavigation()
  return useMemo(() => {
    const decide = (message: EphemeralMessage, label: 'confirm' | 'dismiss') =>
      mutate(
        { id: message.id, label },
        {
          onSuccess: (proposal) => {
            if (opensThread(proposal))
              navigation.newThreadWith(
                { text: '', selections: [], attachments: new AttachmentDraft() },
                proposal.chatId,
              )
          },
        },
      )
    return {
      of: (chat) => rows.filter((row) => row.chat === chat),
      act: (message, action) => {
        const label = labelOf(action)
        if (label !== undefined) decide(message, label)
      },
      dismiss: (message) => decide(message, 'dismiss'),
    }
  }, [rows, mutate, navigation])
}
