import { useCallback, useRef } from 'react'
import { ConversationView, MoveReceipt } from '@goblin/contracts'
import { Schema } from 'effect'
import { request } from '../../lib/boundary.ts'
import { SubmissionRetry } from '../../lib/submission-retry.ts'
import type { StartThread } from '../conversation-dock.tsx'
import { messageBody } from '../use-conversation.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { usePanel } from './panel.tsx'

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ thread: ConversationView }))

/**
 * Start thread from `chat`'s composer (ADR 0034): the message posts as the head of a new thread (`POST …/threads`; the
 * runtime writes the head into `chat`, and the same operation id finds the same thread on a retry), the thread shows at
 * once and the panel opens on it, where the reply lands.
 */
export function useThreadStart(chat: string): StartThread {
  const panel = usePanel()
  const { apply } = useWorkspaceFeed()
  const retry = useRef(
    new SubmissionRetry(() => {
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- One idempotency key per draft, reused while it is retried.
      return crypto.randomUUID()
    }),
  )
  return useCallback<StartThread>(
    async (input, attachments, selections, appContext, personaOrder) => {
      const context = { appContext, attachments, selections, ...(personaOrder !== undefined && { personaOrder }) }
      const operationId = retry.current.operation({ chat, input, attachments, selections })
      const body = messageBody(input, operationId, context)
      const { thread } = decodeStarted(await request(`/api/conversations/${chat}/threads`, { body }))
      apply([{ type: 'conversation', conversation: thread }])
      retry.current.accepted(operationId)
      panel.open(thread.id)
      return true
    },
    [chat, apply, panel],
  )
}

const decodeReceipt = Schema.decodeUnknownSync(MoveReceipt)

/** Asks to move the owner's message `entry` of `chat`, and the turn it started, into a new thread. */
export async function moveToThread(chat: string, entry: number, operationId: string): Promise<MoveReceipt> {
  return decodeReceipt(await request(`/api/conversations/${chat}/move`, { body: { entry, operationId } }))
}
