import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { type AppContext, MAIN_THREAD } from '@purrable/contracts'
import { Alert, AlertDescription, PresenceBorder, PresenceOrb } from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { BrowserPiEvents, ConversationStream, type StreamStatus } from '../lib/conversation-stream.ts'
import { openInteractions } from '../lib/interactions.ts'
import { conversationParts } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import type { ConversationProjection } from '../lib/projection.ts'
import { SharedContextChip } from './apps/offers.tsx'
import { AppsProvider, useApps } from './apps/provider.tsx'
import { AppLayer } from './apps/stage.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { ThreadBar, ThreadList, ThreadsProvider, useThreads } from './threads.tsx'
import { ModelPicker, useModelChoice } from './model-picker.tsx'
import { UsageIndicator } from './usage-indicator.tsx'
import { useUsageToday } from './use-usage.ts'

function useConversation(thread: string) {
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
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- A fresh idempotency key for this browser submission.
      const body = {
        input,
        operationId: operationId ?? crypto.randomUUID(),
        ...(appContext.length > 0 && { appContext }),
      }
      await request(`/api/threads/${thread}/messages`, { body })
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

function StreamNotice({ text }: { readonly text: string }) {
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/**
 * Keeps the transcript clear of the floating composer: `--dock-height` follows the composer's size, and
 * `--keyboard-inset` lifts it above an on-screen keyboard that covers the layout viewport (iOS Safari does not resize it).
 */
function useDockInsets(view: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>) {
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

/**
 * The chat with one of the agent's conversations (`thread`; main is `MAIN_THREAD`): the transcript fills the screen
 * under the header, the conversation list sits beside it, and the composer floats over its bottom edge.
 */
export function Chat({ thread }: { readonly thread: string }) {
  return (
    <ThreadsProvider>
      <AppsProvider key={thread}>
        <ChatView thread={thread} />
      </AppsProvider>
    </ThreadsProvider>
  )
}

type Send = (input: string, operationId?: string, appContext?: readonly AppContext[]) => Promise<boolean>

/** The owner's message, with what the open App shares; the shared context is sent once, then cleared. */
function useSendWithAppContext(send: Send): (input: string) => Promise<boolean> {
  const { session, setContext } = useApps()
  return async (input) => {
    const shared = session?.context
    const context = shared === undefined ? [] : [{ serverId: session?.selection.serverId ?? '', text: shared }]
    const sent = await send(input, undefined, context)
    if (sent && shared !== undefined) setContext('')
    return sent
  }
}

function ChatView({ thread }: { readonly thread: string }) {
  const { projection, status, notice, report, send, stop } = useConversation(thread)
  const threads = useThreads()
  const running = projection?.running ?? false
  const { refresh, create } = threads
  // A run starting or ending changes the list's busy marks (and a first exchange may have named the thread).
  useEffect(refresh, [refresh, running])
  const sendOwn = useSendWithAppContext(send)
  const { choice, choose } = useModelChoice(report)
  const view = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(view, dock)
  const parts = useMemo(() => (projection === undefined ? [] : conversationParts(projection)), [projection])
  const waiting = useMemo(() => openInteractions(parts), [parts])
  const usage = useUsageToday(running)
  const context = useMemo(() => contextTokens(projection?.messages ?? []), [projection])
  const contextWindow = choice?.options.find((option) => option.id === choice.current)?.contextWindow
  const presence = presenceOf({
    status,
    projection,
    parts,
    waiting: waiting.length,
    exhausted: usage !== undefined && budgetFraction(usage) >= 1,
  })
  return (
    <section className="chat-view" aria-label="Chat" ref={view}>
      <aside className="thread-column">
        <ThreadList current={thread} />
      </aside>
      <div className="chat-conversation">
        <ThreadBar thread={thread} />
        <Conversation
          key={thread}
          parts={parts}
          canSwitchModel={(choice?.options.length ?? 0) > 1}
          {...(thread === MAIN_THREAD && { onBranch: (entry: number) => void create(entry) })}
        />
        <div className="chat-dock" ref={dock}>
          {notice && <StreamNotice text={notice} />}
          {threads.error && <StreamNotice text={threads.error} />}
          <InteractionCards interactions={waiting} onAnswer={send} />
          <SharedContextChip />
          <div className="relative">
            {presence.state === 'waiting' && <PresenceBorder />}
            <MessageComposer
              onSend={sendOwn}
              running={running}
              onStop={() => void stop()}
              context={
                <>
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                    <PresenceOrb state={presence.state} label={presence.label} />
                    <span className="truncate">{presence.label}</span>
                  </span>
                  <ModelPicker choice={choice} onChoose={(model) => void choose(model)} />
                  <UsageIndicator usage={usage} context={context} contextWindow={contextWindow} />
                </>
              }
            />
          </div>
        </div>
      </div>
      <AppLayer />
    </section>
  )
}
