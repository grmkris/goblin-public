import { useEffect, useMemo, useRef } from 'react'
import { type AppContext, MAIN_THREAD } from '@purrable/contracts'
import { Alert, AlertDescription, Button, PresenceBorder, PresenceOrb } from '@purrable/ui'
import { ShareIcon } from 'lucide-react'
import { openInteractions } from '../lib/interactions.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import { SharedContextChip } from './apps/offers.tsx'
import { AppsProvider, useApps } from './apps/provider.tsx'
import { AppLayer } from './apps/stage.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { ThreadBar, ThreadList, useGoToThread, useThreads } from './threads.tsx'
import { ModelPicker, useModelChoice } from './model-picker.tsx'
import { UsageIndicator } from './usage-indicator.tsx'
import { useConversation, useDockInsets, useTranscript } from './use-conversation.ts'
import { useUsageToday } from './use-usage.ts'

/** What "Share to main" asks a thread's agent; it answers with `share_to_main`. */
const SHARE_REQUEST = 'Share what we concluded here with main.'

function StreamNotice({ text }: { readonly text: string }) {
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/**
 * The chat with one of the agent's conversations (`thread`; main is `MAIN_THREAD`): the transcript fills the screen
 * under the header, the conversation list sits beside it, and the composer floats over its bottom edge.
 */
export function Chat({ thread }: { readonly thread: string }) {
  return (
    <AppsProvider key={thread}>
      <ChatView thread={thread} />
    </AppsProvider>
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
  const goTo = useGoToThread()
  const running = projection?.running ?? false
  const { refresh, create } = threads
  const kind = threads.views.find((candidate) => candidate.id === thread)?.kind
  // A run starting or ending changes the list's busy marks (and a first exchange may have named the thread).
  useEffect(refresh, [refresh, running])
  const sendOwn = useSendWithAppContext(send)
  const { choice, choose } = useModelChoice(report)
  const view = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(view, dock)
  const { parts, earlier } = useTranscript(thread, projection, report)
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
        <ThreadBar
          thread={thread}
          actions={
            kind === 'thread' && (
              <Button variant="ghost" size="sm" disabled={running} onClick={() => void send(SHARE_REQUEST)}>
                <ShareIcon data-icon="inline-start" />
                Share to main
              </Button>
            )
          }
        />
        <Conversation
          key={thread}
          parts={parts}
          canSwitchModel={(choice?.options.length ?? 0) > 1}
          {...(earlier && { onEarlier: earlier })}
          {...(thread === MAIN_THREAD && { onBranch: (entry: number) => void create(entry).then(goTo) })}
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
