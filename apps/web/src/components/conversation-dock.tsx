import { type RefObject, useMemo } from 'react'
import type { ComposerSelection } from '@goblin/contracts'
import { Alert, AlertDescription, Button, PresenceBorder, PresenceOrb } from '@goblin/ui'
import { RotateCcwIcon } from 'lucide-react'
import { openInteractions } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import { conversationKey } from '../lib/workspace.ts'
import { SharedContextChips, useSharedContext } from './apps/offers.tsx'
import { CapabilitiesButton } from './capabilities.tsx'
import { MessageComposer } from './composer.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { ModelPicker, type useModelChoice } from './model-picker.tsx'
import { UsageIndicator } from './usage-indicator.tsx'
import type { useConversation } from './use-conversation.ts'
import { useWorkspace } from './workspace.tsx'
import { useUsageToday } from './use-usage.ts'

type Send = ReturnType<typeof useConversation>['send']

export function Notice({ text }: { readonly text: string }) {
  if (text === '') return null
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/**
 * The owner's message, with the files they attached and what the conversation's Apps share; shared context is sent
 * once, then cleared.
 */
export function useSendWithAppContext(
  conversation: string,
  send: Send,
): (input: string, attachments: readonly string[], selections: readonly ComposerSelection[]) => Promise<boolean> {
  const shared = useSharedContext(conversation)
  return async (input, attachments, selections) => {
    const sent = await send(input, undefined, { appContext: shared.context, attachments, selections })
    if (sent) shared.clear()
    return sent
  }
}

/** Why a conversation takes no message: the owner closed it, or, for a subagent, its job was done. */
function ClosedNotice({ by, onReopen }: { readonly by: 'owner' | 'done'; readonly onReopen: () => void }) {
  return (
    <div className="pane-closed" role="status">
      <span>
        {by === 'done'
          ? 'Its job is done, so it closed. Its spawner can send it more; reopen it to write to it yourself.'
          : 'Closed. It and everything under it run nothing until it is reopened.'}
      </span>
      <Button variant="outline" size="sm" onClick={onReopen}>
        <RotateCcwIcon data-icon="inline-start" />
        Reopen
      </Button>
    </div>
  )
}

/** What the composer shows beside its buttons: what the agent is doing, the model, what it may use, the day's usage. */
function ComposerContext({
  id,
  running,
  presence,
  model,
  usage,
  context,
}: {
  readonly id: string
  readonly running: boolean
  readonly presence: ReturnType<typeof presenceOf>
  readonly model: ReturnType<typeof useModelChoice>
  readonly usage: ReturnType<typeof useUsageToday>
  readonly context: number | undefined
}) {
  const focused = useWorkspace().state.focused === conversationKey(id)
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <PresenceOrb state={presence.state} label={presence.label} active={focused} />
        <span className="truncate">{presence.label}</span>
      </span>
      <ModelPicker choice={model.choice} onChoose={(picked) => void model.choose(picked)} />
      <CapabilitiesButton thread={id} running={running} />
      <UsageIndicator
        usage={usage}
        context={context}
        contextWindow={model.choice?.options.find((option) => option.id === model.choice?.current)?.contextWindow}
      />
    </>
  )
}

/**
 * The dock's notices and what waits on the owner (cards, shared context). They scroll on their own, so however much
 * there is, the transcript and the composer still show.
 */
function DockCards({
  notices,
  open,
  waiting,
  id,
  onAnswer,
}: {
  readonly notices: readonly string[]
  readonly open: boolean
  readonly waiting: ReturnType<typeof openInteractions>
  readonly id: string
  readonly onAnswer: Parameters<typeof InteractionCards>[0]['onAnswer']
}) {
  return (
    <div className="dock-cards">
      {notices.map((text, index) => (
        <Notice key={`${index}:${text}`} text={text} />
      ))}
      {open && (
        <>
          <InteractionCards interactions={waiting} thread={id} onAnswer={onAnswer} />
          <SharedContextChips conversation={id} />
        </>
      )}
    </div>
  )
}

/**
 * Under a conversation's transcript, floating over its bottom edge: what waits on the owner, then the composer with
 * what the agent is doing, the model, what it may use here and the day's usage. A closed conversation offers Reopen
 * instead of a composer.
 */
export function ConversationDock({
  ref,
  id,
  conversation,
  parts,
  model,
  closed,
  onReopen,
  notices = [],
  hint,
  placeholder,
  sendLabel,
  draft,
}: {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly id: string
  readonly conversation: ReturnType<typeof useConversation>
  readonly model: ReturnType<typeof useModelChoice>
  readonly draft?: { readonly text: string } | undefined
  readonly parts: readonly Part[]
  /** Who closed it, when it is closed. */
  readonly closed: 'owner' | 'done' | undefined
  readonly onReopen: () => void
  readonly notices?: readonly string[]
  /** A quiet line under the composer: what writing here does. */
  readonly hint?: string | undefined
  /** What the empty composer says; the default asks the agent. */
  readonly placeholder?: string | undefined
  /** What the send button says; Send by default. */
  readonly sendLabel?: string | undefined
}) {
  const workspace = useWorkspace()
  const { projection, status, notice, send, stop } = conversation
  const running = projection?.running ?? false
  const sendOwn = useSendWithAppContext(id, send)
  const usage = useUsageToday(running)
  const waiting = useMemo(() => openInteractions(parts), [parts])
  const context = useMemo(() => contextTokens(projection?.messages ?? []), [projection])
  const presence = presenceOf({
    status,
    projection,
    parts,
    waiting: waiting.length,
    exhausted: usage !== undefined && budgetFraction(usage) >= 1,
  })
  return (
    <div className="chat-dock" ref={ref} data-app-cover>
      <DockCards notices={[notice, ...notices]} open={closed === undefined} waiting={waiting} id={id} onAnswer={send} />
      {closed !== undefined ? (
        <ClosedNotice by={closed} onReopen={onReopen} />
      ) : (
        <>
          <div className="dock-composer relative">
            {presence.state === 'waiting' && <PresenceBorder />}
            <MessageComposer
              conversation={id}
              onNewThread={(contents) => workspace.moveDraft(contents, conversationKey(id))}
              draft={draft}
              onSend={sendOwn}
              attach
              running={running}
              onStop={() => void stop()}
              {...(placeholder !== undefined && { placeholder })}
              {...(sendLabel !== undefined && { sendLabel })}
              context={
                <ComposerContext
                  id={id}
                  running={running}
                  presence={presence}
                  model={model}
                  usage={usage}
                  context={context}
                />
              }
            />
          </div>
          {hint !== undefined && <p className="dock-hint">{hint}</p>}
        </>
      )}
    </div>
  )
}
