import { useCallback, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { startThreadMutation } from '../../conversations/queries.ts'
import { SubmissionRetry } from '../../lib/submission-retry.ts'
import type { StartThread } from '../conversation-dock.tsx'
import { messageBody } from '../use-conversation.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { usePanel } from './panel.tsx'

/**
 * Start thread from `chat`'s composer (ADR 0034): the message posts as the head of a new thread (`POST …/threads`; the
 * runtime writes the head into `chat`, and the same operation id finds the same thread on a retry), the thread shows at
 * once and the panel opens on it, where the reply lands.
 */
export function useThreadStart(chat: string): StartThread {
  const panel = usePanel()
  const { apply } = useWorkspaceFeed()
  const start = useMutation(startThreadMutation).mutateAsync
  const retry = useRef(
    new SubmissionRetry(() => {
      return crypto.randomUUID()
    }),
  )
  return useCallback<StartThread>(
    async (input, attachments, selections, appContext, personaOrder) => {
      const context = { appContext, attachments, selections, ...(personaOrder !== undefined && { personaOrder }) }
      const operationId = retry.current.operation({ chat, input, attachments, selections })
      const { thread } = await start({ id: chat, message: messageBody(input, operationId, context) })
      apply([{ type: 'conversation', conversation: thread }])
      retry.current.accepted(operationId)
      panel.open(thread.id)
      return true
    },
    [chat, apply, panel, start],
  )
}
