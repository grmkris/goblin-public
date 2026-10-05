import { type RefObject, useEffect, useMemo, useRef } from 'react'
import { type AppContext, MAIN_THREAD } from '@purrable/contracts'
import { Alert, AlertDescription, Button, PresenceBorder, PresenceOrb } from '@purrable/ui'
import { ShareIcon } from 'lucide-react'
import { openInteractions } from '../lib/interactions.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import { SharedContextChip } from './apps/offers.tsx'
import { AppsProvider, useApps } from './apps/provider.tsx'
import { CapabilitiesButton } from './capabilities.tsx'
import { AppLayer } from './apps/stage.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import type { Part } from '../lib/parts.ts'
import { ChatBar } from './chat-bar.tsx'
import { type ThreadPanelControl } from './thread-panel.tsx'
import { WorkspaceLayout } from './workspace-layout.tsx'
import { WorkspaceProvider, useWorkspace } from './workspace-state.tsx'
import { useInlineThreads } from './thread-replies.tsx'
import { useThreads } from './threads.tsx'
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
export function Chat({ thread, panel }: { readonly thread: string; readonly panel?: ThreadPanelControl }) {
  return (
    <AppsProvider key={thread}>
      <WorkspaceProvider primary={thread} panel={panel}>
        <ChatView thread={thread} panel={panel} />
      </WorkspaceProvider>
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

type ChatConversation = ReturnType<typeof useConversation>
type ModelChoice = ReturnType<typeof useModelChoice>

/** The composer floating over the transcript's bottom edge, with what waits on the owner above it. */
function ChatDock({
  ref,
  thread,
  conversation,
  parts,
  waiting,
  model,
}: {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly thread: string
  readonly conversation: ChatConversation
  readonly parts: readonly Part[]
  readonly waiting: ReturnType<typeof openInteractions>
  readonly model: ModelChoice
}) {
  const { projection, status, notice, send, stop } = conversation
  const threads = useThreads()
  const running = projection?.running ?? false
  const sendOwn = useSendWithAppContext(send)
  const usage = useUsageToday(running)
  const context = useMemo(() => contextTokens(projection?.messages ?? []), [projection])
  const { choice, choose } = model
  const contextWindow = choice?.options.find((option) => option.id === choice.current)?.contextWindow
  const presence = presenceOf({
    status,
    projection,
    parts,
    waiting: waiting.length,
    exhausted: usage !== undefined && budgetFraction(usage) >= 1,
  })
  return (
    <div className="chat-dock" ref={ref}>
      {notice && <StreamNotice text={notice} />}
      {threads.error && <StreamNotice text={threads.error} />}
      <InteractionCards interactions={waiting} thread={thread} onAnswer={send} />
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
              <ModelPicker choice={choice} onChoose={(picked) => void choose(picked)} />
              <CapabilitiesButton thread={thread} running={running} />
              <UsageIndicator usage={usage} context={context} contextWindow={contextWindow} />
            </>
          }
        />
      </div>
    </div>
  )
}

const NOWHERE = () => undefined

function ChatView({ thread, panel }: { readonly thread: string; readonly panel: ThreadPanelControl | undefined }) {
  const conversation = useConversation(thread)
  const { projection, report, send } = conversation
  const threads = useThreads()
  const running = projection?.running ?? false
  const { refresh } = threads
  const kind = threads.views.find((candidate) => candidate.id === thread)?.kind
  // A run starting or ending changes the list's busy marks (and a first exchange may have named the thread).
  useEffect(refresh, [refresh, running])
  const model = useModelChoice(report)
  const view = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(view, dock)
  const { parts, branchable, earlier } = useTranscript(thread, projection, report)
  const waiting = useMemo(() => openInteractions(parts), [parts])
  // Threads start from main and show under its messages; a thread does not branch further.
  const workspace = useWorkspace()
  const inline = useInlineThreads(branchable, workspace.openThread, panel?.reply ?? NOWHERE)
  const inlineThreads = thread === MAIN_THREAD && panel !== undefined ? inline : undefined
  return (
    <section className="chat-view" aria-label="Chat" ref={view}>
      <WorkspaceLayout panel={panel} parts={parts}>
        <div className="chat-conversation chat-pane">
          <ChatBar
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
            canSwitchModel={(model.choice?.options.length ?? 0) > 1}
            {...(earlier && { onEarlier: earlier })}
            {...(inlineThreads && { threads: inlineThreads })}
          />
          <ChatDock
            ref={dock}
            thread={thread}
            conversation={conversation}
            parts={parts}
            waiting={waiting}
            model={model}
          />
        </div>
      </WorkspaceLayout>
      <AppLayer />
    </section>
  )
}
