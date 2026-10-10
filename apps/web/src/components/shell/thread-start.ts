import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AppContext, ComposerSelection, StartThread as StartThreadOperation } from '@goblin/contracts'
import { startThreadMutation, submitMutation } from '../../conversations/queries.ts'
import { DraftThread } from '../../lib/draft-thread.ts'
import { SubmissionRetry } from '../../lib/submission-retry.ts'
import { applyWorkspaceChanges } from '../../lib/workspace/sync.ts'
import type { StartThread } from '../conversation-dock.tsx'
import { messageBody } from '../use-conversation.ts'
import { usePanel } from './panel.tsx'

/** A thread operation's first message as the API takes it: the words, and only what came with them. */
function threadMessage(
  input: string,
  attachments: readonly string[],
  selections: readonly ComposerSelection[],
  appContext: readonly AppContext[],
): StartThreadOperation['message'] {
  return {
    input,
    ...(appContext.length > 0 && { appContext }),
    ...(attachments.length > 0 && { attachments }),
    ...(selections.length > 0 && { selections }),
  }
}

/**
 * Start thread from `chat`'s composer (ADR 0034): one call (`POST …/threads`, anchored at the chat's newest settled
 * entry) makes the thread, posts the message as its head in `chat` and sends it as the thread's first message; the same
 * operation id finds the same thread on a retry. The thread shows at once and the panel opens on it, where the reply
 * lands.
 */
export function useThreadStart(chat: string): StartThread {
  const panel = usePanel()
  const queryClient = useQueryClient()
  const start = useMutation(startThreadMutation).mutateAsync
  const retry = useRef(
    new SubmissionRetry(() => {
      return crypto.randomUUID()
    }),
  )
  return useCallback<StartThread>(
    async (input, attachments, selections, appContext, personaOrder) => {
      const operationId = retry.current.operation({ chat, input, attachments, selections })
      const message = threadMessage(input, attachments, selections, appContext)
      const anchor = 'latest'
      const { thread } = await start({
        id: chat,
        start: { operationId, anchor, message, ...(personaOrder !== undefined && { personaOrder }) },
      })
      applyWorkspaceChanges(queryClient, [{ type: 'conversation', conversation: thread }])
      retry.current.accepted(operationId)
      panel.open(thread.id)
      return true
    },
    [chat, queryClient, panel, start],
  )
}

/** What a draft thread's first send carries: the unified operation's anchor, message and order, less its id. */
export type DraftStart = Omit<StartThreadOperation, 'operationId'>

/**
 * A draft thread's sends, Reply on a message of `chat` or "+" in it (ADR 0034). The draft lives in the browser until
 * its first send, which is one call of the unified operation under the draft's one operation id: it makes the thread
 * and sends that message as its first, so a retry asks for the same thread and the same message. A send while the first
 * is on its way waits for the same thread, then goes into it as a message of its own. Resolves the thread's id.
 */
export function useDraftStart(chat: string) {
  const queryClient = useQueryClient()
  const start = useMutation(startThreadMutation).mutateAsync
  const submit = useMutation(submitMutation).mutateAsync
  const [draft] = useState(() => new DraftThread(crypto.randomUUID(), () => crypto.randomUUID()))
  return useCallback(
    async ({ anchor, message, personaOrder }: DraftStart): Promise<string | undefined> => {
      let first = false
      const thread = await draft.thread(async (operationId) => {
        first = true
        const order = personaOrder !== undefined && { personaOrder }
        const started = await start({ id: chat, start: { operationId, anchor, message, ...order } })
        applyWorkspaceChanges(queryClient, [{ type: 'conversation', conversation: started.thread }])
        return started.thread.id
      })
      if (thread === undefined || first) return thread
      const id = draft.message({ thread, message, personaOrder })
      const { input, appContext = [], attachments = [], selections = [] } = message
      const context = { appContext, attachments, selections, ...(personaOrder !== undefined && { personaOrder }) }
      await submit({ id: thread, message: messageBody(input, id, context) })
      draft.sent(id)
      return thread
    },
    [chat, draft, queryClient, start, submit],
  )
}
