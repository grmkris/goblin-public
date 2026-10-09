import { useCallback, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { StartThread as StartThreadOperation } from '@goblin/contracts'
import { startThreadMutation, submitMutation } from '../../conversations/queries.ts'
import { DraftThread } from '../../lib/draft-thread.ts'
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

/** What a draft thread's first send carries: the unified operation's anchor, message and order, less its id. */
export type DraftStart = Omit<StartThreadOperation, 'operationId'>

/**
 * A draft thread's first send, Reply on a message of `chat` or "+" in it (ADR 0034). The draft lives in the browser
 * until then: the thread is made only now, under the draft's one operation id, so a second send while the first is on
 * its way waits for the same Thread, and a retry asks for the same one. It speaks the unified operation's shape
 * (`StartThread`); until the API takes that in one call, it runs as the create of the operation (`topic` places an empty
 * thread), then the first message as an operation of its own. Resolves the thread's id, or undefined when it could not
 * be made (the workspace feed says why).
 */
export function useDraftStart(chat: string, topic: number | undefined) {
  const { create } = useWorkspaceFeed()
  const submit = useMutation(submitMutation).mutateAsync
  const [draft] = useState(() => new DraftThread(crypto.randomUUID(), () => crypto.randomUUID()))
  return useCallback(
    async ({ anchor, message, personaOrder }: DraftStart): Promise<string | undefined> => {
      const thread = await draft.thread(async (operationId) => {
        const where =
          anchor === 'empty' ? topic !== undefined && { topic } : { from: { conversation: chat, ...anchor } }
        return (await create({ operationId, ...where }))?.id
      })
      if (thread === undefined) return undefined
      const id = draft.message({ thread, message, personaOrder })
      const { input, appContext = [], attachments = [], selections = [] } = message
      const context = { appContext, attachments, selections, ...(personaOrder !== undefined && { personaOrder }) }
      await submit({ id: thread, message: messageBody(input, id, context) })
      draft.sent(id)
      return thread
    },
    [chat, topic, draft, create, submit],
  )
}
