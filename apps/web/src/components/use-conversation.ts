import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppContext } from '@purrable/contracts'
import { failureText, isNumber, record, records, request } from '../lib/boundary.ts'
import { BrowserPiEvents, ConversationStream, type StreamStatus } from '../lib/conversation-stream.ts'
import { conversationParts } from '../lib/parts.ts'
import { type ConversationProjection, entryMessages, historyStart } from '../lib/projection.ts'
import { branchPoints, fromEntry } from '../lib/threads.ts'

/**
 * Submits the owner's message to a conversation. A stable `operationId` makes a retry the same message (answers to a
 * question or permission request); a typed message gets a fresh one.
 */
export async function postMessage(
  thread: string,
  input: string,
  operationId?: string,
  appContext: readonly AppContext[] = [],
): Promise<void> {
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- A fresh idempotency key for this browser submission.
  const body = { input, operationId: operationId ?? crypto.randomUUID(), ...(appContext.length > 0 && { appContext }) }
  await request(`/api/threads/${thread}/messages`, { body })
}

/**
 * One conversation of the agent as the browser follows it: a Pi snapshot, then the event stream (reconnecting on
 * focus and when the network returns), with sending and stopping. The chat and the thread panel each hold one.
 */
export function useConversation(thread: string) {
  const [projection, setProjection] = useState<ConversationProjection>()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [notice, setNotice] = useState('')
  const stream = useRef<ConversationStream | undefined>(undefined)
  useEffect(() => {
    const attachment = new ConversationStream(
      {
        snapshot: (signal) => request(`/api/threads/${thread}/snapshot`, { signal }),
        events: () => new BrowserPiEvents(`/api/threads/${thread}/events`),
      },
      setProjection,
      (next, detail) => {
        setStatus(next)
        setNotice(next === 'reconnecting' ? `${detail ?? 'Disconnected'}. Reconnecting…` : '')
      },
    )
    stream.current = attachment
    void attachment.reconnect()
    const resume = () => {
      if (document.visibilityState === 'visible') void attachment.reconnect()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      attachment.dispose()
    }
  }, [thread])
  /** `operationId` is stable for replies to a question or permission request; a typed message gets a fresh one. */
  async function send(input: string, operationId?: string, appContext: readonly AppContext[] = []): Promise<boolean> {
    try {
      await postMessage(thread, input, operationId, appContext)
      return true
    } catch (error) {
      setNotice(failureText(error))
      return false
    }
  }
  async function stop(): Promise<void> {
    try {
      await request(`/api/threads/${thread}/stop`, { body: {} })
    } catch (error) {
      setNotice(failureText(error))
    }
  }
  return { projection, status, notice, report: setNotice, send, stop }
}

type HistoryPage = { readonly entries: readonly Record<string, unknown>[]; readonly more: boolean }

/**
 * The conversation before what its snapshot shows: once a memory view or a summary starts the model's context later,
 * the snapshot starts there too. The page before `start` loads on its own; `earlier` loads the next older one.
 */
function useHistory(thread: string, start: number | undefined, report: (text: string) => void) {
  const [page, setPage] = useState<HistoryPage>({ entries: [], more: false })
  const load = useCallback(
    async (before: number): Promise<HistoryPage> => {
      const data = record(await request(`/api/threads/${thread}/history?before=${before}`))
      return { entries: records(data?.entries), more: data?.more === true }
    },
    [thread],
  )
  useEffect(() => {
    let current = true
    setPage({ entries: [], more: false })
    if (start !== undefined)
      load(start)
        .then((first) => current && setPage(first))
        .catch((failure: unknown) => report(failureText(failure)))
    return () => {
      current = false
    }
  }, [load, start, report])
  const oldest = page.entries[0]?.id
  const earlier =
    page.more && isNumber(oldest)
      ? () =>
          void load(oldest)
            .then((older) => setPage((shown) => ({ entries: [...older.entries, ...shown.entries], more: older.more })))
            .catch((failure: unknown) => report(failureText(failure)))
      : undefined
  return { entries: page.entries, earlier }
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
    const messages = [...entryMessages(history.entries), ...projection.messages]
    return conversationParts({ ...projection, messages: floor === undefined ? messages : fromEntry(messages, floor) })
  }, [projection, history.entries, floor])
  // Which of the parts' entries a thread can branch from (a shared note in main cannot).
  const branchable = useMemo(
    () => branchPoints([...history.entries, ...(projection?.entries ?? [])]),
    [projection, history.entries],
  )
  const oldest = history.entries[0]?.id
  const reachedFloor = floor !== undefined && isNumber(oldest) && oldest <= floor
  return { parts, branchable, earlier: reachedFloor ? undefined : history.earlier }
}

/**
 * Keeps the transcript clear of the floating composer: `--dock-height` follows the composer's size, and
 * `--keyboard-inset` lifts it above an on-screen keyboard that covers the layout viewport (iOS Safari does not resize it).
 */
export function useDockInsets(view: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = view.current
    const element = dock.current
    if (!root || !element) return
    const viewport = window.visualViewport
    const keyboard = () => {
      const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
    }
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize ?? element.offsetHeight
      root.style.setProperty('--dock-height', `${Math.round(height)}px`)
    })
    observer.observe(element)
    keyboard()
    viewport?.addEventListener('resize', keyboard)
    viewport?.addEventListener('scroll', keyboard)
    return () => {
      observer.disconnect()
      viewport?.removeEventListener('resize', keyboard)
      viewport?.removeEventListener('scroll', keyboard)
    }
  }, [view, dock])
}
