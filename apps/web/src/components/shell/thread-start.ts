import { useCallback, useRef } from 'react'
import { MoveReceipt } from '@goblin/contracts'
import { Schema } from 'effect'
import { isNumber, isString, record, request } from '../../lib/boundary.ts'
import { hasFeature, lacks, missing } from '../../lib/features.ts'
import { SubmissionRetry } from '../../lib/submission-retry.ts'
import type { StartThread } from '../conversation-dock.tsx'
import { messageBody, postMessage } from '../use-conversation.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { usePanel } from './panel.tsx'

/** The thread a start-thread answer names: `{ thread }` (a receipt) or the thread's own view (`{ id }`). */
function threadOf(data: unknown): string | undefined {
  const answer = record(data)
  const id = answer?.thread ?? answer?.id
  if (isString(id) && /^\d{1,12}$/u.test(id)) return id
  return isNumber(id) && Number.isSafeInteger(id) ? String(id) : undefined
}

/**
 * Start thread from `chat`'s composer: the message posts as the head of a new thread (`POST …/threads`, the same
 * operation id finding the same thread on a retry) and the panel opens on it, where the reply lands. A server without
 * that route gets the thread the old way: a new empty thread of the Topic, then the message in it.
 */
export function useThreadStart(chat: string, topic: number | undefined): StartThread {
  const panel = usePanel()
  const { create } = useWorkspaceFeed()
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
      let thread: string | undefined
      if (await hasFeature('threads', chat))
        try {
          const body = messageBody(input, operationId, context)
          thread = threadOf(await request(`/api/conversations/${chat}/threads`, { body }))
        } catch (failure) {
          if (!missing(failure)) throw failure
          lacks('threads')
        }
      if (thread === undefined) {
        const created = await create(undefined, topic)
        if (created === undefined) return false
        await postMessage(created.id, input, operationId, context)
        thread = created.id
      }
      retry.current.accepted(operationId)
      panel.open(thread)
      return true
    },
    [chat, topic, create, panel],
  )
}

const decodeReceipt = Schema.decodeUnknownSync(MoveReceipt)

/** Asks to move the owner's message `entry` of `chat`, and the turn it started, into a new thread. */
export async function moveToThread(chat: string, entry: number, operationId: string): Promise<MoveReceipt> {
  return decodeReceipt(await request(`/api/conversations/${chat}/move`, { body: { entry, operationId } }))
}
