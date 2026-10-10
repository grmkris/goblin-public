import { type RefObject, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import type { AppContext, ComposerSelection } from '@goblin/contracts'
import {
  historyQuery,
  removeQueuedMutation,
  stopMutation,
  streamReads,
  submitMutation,
} from '../conversations/queries.ts'
import { isNumber, records } from '../lib/values.ts'
import { BrowserPiEvents, type StreamStatus } from '../lib/conversation-stream.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { reportUnexpected } from '../lib/unexpected.ts'
import { type Lease, type StreamState, StreamPool } from '../lib/stream-pool.ts'
import { conversationParts } from '../lib/conversation-parts.ts'
import { entryMessages, omittedEntries } from '../lib/entry-messages.ts'
import { type ConversationProjection, historyStart } from '../lib/projection.ts'
import { branchPoints, fromEntry } from '../lib/threads.ts'
import { SubmissionRetry } from '../lib/submission-retry.ts'
import { useKeyboardInset } from './use-keyboard.ts'

type MessageContext = {
  readonly appContext?: readonly AppContext[]
  readonly attachments?: readonly string[]
  readonly selections?: readonly ComposerSelection[]
  /** With two or more Personas tagged: together, or one after another ("then"). */
  readonly personaOrder?: 'parallel' | 'sequence'
}

/** The body of an owner message (`SendMessage`), with nothing empty in it. */
export function messageBody(
  input: string,
  operationId: string,
  { appContext = [], attachments = [], selections = [], personaOrder }: MessageContext = {},
) {
  return {
    input,
    operationId,
    ...(appContext.length > 0 && { appContext }),
    ...(attachments.length > 0 && { attachments }),
    ...(selections.length > 0 && { selections }),
    ...(personaOrder !== undefined && { personaOrder }),
  }
}

/** Every conversation the browser follows, shared by the panes and inline threads that show it. */
const streams = new StreamPool((thread) => ({
  ...streamReads(thread),
  events: () => new BrowserPiEvents(`/api/conversations/${thread}/events`),
}))

let resuming = false
/** Coming back to the tab, or back online, every followed conversation starts again from a fresh snapshot. */
function resumeWithThePage(): void {
  if (resuming) return
  resuming = true
  const resume = () => {
    if (document.visibilityState === 'visible') streams.resume()
  }
  window.addEventListener('online', resume)
  document.addEventListener('visibilitychange', resume)
}

const FOLLOWING: StreamState = { projection: undefined, status: 'connecting', notice: '' }

/**
 * One conversation of the agent as the browser follows it, from the shared stream pool: a Pi snapshot, then the
 * event stream, with sending and stopping. `visible` says whether it is on screen; one nobody sees for a while stops
 * following until it is (its last state stays).
 */
export function useConversation(thread: string, visible = true) {
  const [state, setState] = useState<StreamState>(FOLLOWING)
  const [failure, setFailure] = useState('')
  const retry = useRef(
    new SubmissionRetry(() => {
      return crypto.randomUUID()
    }),
  )
  const lease = useRef<Lease | undefined>(undefined)
  // Whether it is on screen when the stream is taken up; later changes go through the lease below.
  const visibleNow = useEffectEvent(() => visible)
  useEffect(() => {
    resumeWithThePage()
    const held = streams.acquire(thread, visibleNow(), setState)
    lease.current = held
    return () => {
      held.release()
      lease.current = undefined
    }
  }, [thread])
  useEffect(() => lease.current?.setVisible(visible), [visible])
  const submit = useMutation(submitMutation).mutateAsync
  const stopping = useMutation(stopMutation).mutateAsync
  const removing = useMutation(removeQueuedMutation).mutateAsync
  /** Replies retain their supplied operation; an unchanged failed draft reuses its browser operation. */
  async function send(input: string, operationId?: string, context: MessageContext = {}): Promise<boolean> {
    const id = operationId ?? retry.current.operation({ thread, input, context })
    try {
      await submit({ id: thread, message: messageBody(input, id, context) })
      retry.current.accepted(id)
      streams.refreshQueue(thread)
      setFailure('')
      return true
    } catch (error) {
      setFailure(messageOf(error, 'send the message'))
      if ((context.selections?.length ?? 0) > 0) throw error
      return false
    }
  }
  async function stop(): Promise<void> {
    try {
      await stopping(thread)
    } catch (error) {
      setFailure(messageOf(error, 'stop'))
    }
  }
  async function removeQueued(submissionId: number): Promise<boolean> {
    try {
      const result = await removing({ id: thread, removal: { submissionId } })
      streams.refreshQueue(thread)
      setFailure(
        result.status === 'removed'
          ? ''
          : result.status === 'already_started'
            ? 'This message has already started.'
            : 'This message is no longer queued.',
      )
      return result.status === 'removed'
    } catch (error) {
      setFailure(messageOf(error, 'remove the queued message'))
      return false
    }
  }
  // A suspended conversation is off screen; it shows its last state as it was.
  const status: StreamStatus = state.status === 'suspended' ? 'connected' : state.status
  return {
    projection: state.projection,
    status,
    notice: failure === '' ? state.notice : failure,
    report: setFailure,
    send,
    stop,
    removeQueued,
  }
}

/**
 * The conversation before what its snapshot shows: once a memory view or a summary starts the model's context later,
 * the snapshot starts there too. The page before `start` loads on its own; `earlier` loads the next older one. A failed
 * page is reported as the conversation's notice.
 */
function useHistory(thread: string, start: number | undefined, report: (text: string) => void) {
  const history = useInfiniteQuery(historyQuery(thread, start))
  const { error, data, hasNextPage, fetchNextPage } = history
  useEffect(() => {
    if (error !== null) report(messageOf(error, 'load earlier messages'))
  }, [error, report])
  const entries = useMemo(() => (data?.pages ?? []).toReversed().flatMap((page) => records(page.entries)), [data])
  const earlier = hasNextPage
    ? () => {
        fetchNextPage().catch(reportUnexpected)
      }
    : undefined
  return { entries, earlier }
}

/**
 * The transcript's parts: the history pages loaded so far, then the snapshot and what streamed since. With `floor` (a
 * branched thread in its panel) it starts at that entry, the message the thread branched from, and reads no history
 * from before it. `branchable` holds the entries a thread may start from.
 */
export function useTranscript(
  thread: string,
  projection: ConversationProjection | undefined,
  report: (text: string) => void,
  floor?: number,
) {
  const start = projection === undefined ? undefined : historyStart(projection)
  const needed = floor === undefined || (start !== undefined && start > floor) ? start : undefined
  const history = useHistory(thread, needed, report)
  const parts = useMemo(() => {
    if (projection === undefined) return []
    // A later entry's edits may omit an older one from a page of history (a turn moved out of this chat).
    const omitted = omittedEntries([...history.entries, ...projection.entries])
    const messages = [...entryMessages(history.entries, omitted), ...projection.messages]
    return conversationParts({ ...projection, messages: floor === undefined ? messages : fromEntry(messages, floor) })
  }, [projection, history.entries, floor])
  // Which of the parts' entries a thread can branch from (a shared note in main cannot). Keyed on the entries, which
  // keep their identity across a streamed batch, so the transcript's footers do not render again with every batch.
  const entries = projection?.entries
  const branchable = useMemo(() => branchPoints([...history.entries, ...(entries ?? [])]), [entries, history.entries])
  const oldest = history.entries[0]?.id
  const reachedFloor = floor !== undefined && isNumber(oldest) && oldest <= floor
  return { parts, branchable, earlier: reachedFloor ? undefined : history.earlier }
}

/**
 * Keeps the transcript clear of the floating composer: `--dock-height` follows the composer's size, and
 * `--keyboard-inset` lifts it above an on-screen keyboard that covers the layout viewport (iOS Safari does not resize it).
 */
export function useDockInsets(view: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>) {
  const keyboardInset = useKeyboardInset()
  useEffect(() => {
    const root = view.current
    const element = dock.current
    if (!root || !element) return
    root.style.setProperty('--keyboard-inset', `${Math.round(keyboardInset)}px`)
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize ?? element.offsetHeight
      root.style.setProperty('--dock-height', `${Math.round(height)}px`)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [view, dock, keyboardInset])
}
