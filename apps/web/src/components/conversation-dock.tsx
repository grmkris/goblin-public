import { type RefObject, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AppContext, ComposerSelection, UsageToday } from '@goblin/contracts'
import { Alert, AlertDescription, Button, PresenceBorder, PresenceOrb } from '@goblin/ui'
import { RotateCcwIcon } from 'lucide-react'
import { modelQuery, usageQuery } from '../agent/queries.ts'
import { useStoredStates } from '../approvals/hooks.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { openInteractions, stillOpen, waitingOnOwner } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import { useNavigation } from '../lib/navigation.ts'
import { usePersonas } from '../lib/workspace/hooks.ts'
import { SharedContextChips, useSharedContext } from './apps/offers.tsx'
import { MessageComposer } from './composer.tsx'
import type { SendExtras } from './composer-state.ts'
import { QueuedMessages } from './queued-messages.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { ModelPicker } from './model-picker.tsx'
import { SetupButton } from './topic-setup.tsx'
import { UsageIndicator } from './usage-indicator.tsx'
import type { useConversation } from './use-conversation.ts'

type Send = ReturnType<typeof useConversation>['send']

/** Posts a message as the head of a new thread, its reply landing there: true once it is on its way. */
export type StartThread = (
  input: string,
  attachments: readonly string[],
  selections: readonly ComposerSelection[],
  appContext: readonly AppContext[],
  personaOrder: SendExtras['personaOrder'],
) => Promise<boolean>

export function Notice({ text }: { readonly text: string }) {
  if (text === '') return null
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/**
 * The owner's message, with the files they attached and what the conversation's Apps share (sent once, then cleared):
 * here, or as a new thread's head when Start thread is on.
 */
const withSharedContext =
  (shared: ReturnType<typeof useSharedContext>, send: Send, startThread: StartThread | undefined) =>
  async (
    input: string,
    attachments: readonly string[],
    selections: readonly ComposerSelection[],
    extras: SendExtras,
  ): Promise<boolean> => {
    const { personaOrder } = extras
    const sent =
      extras.thread === true && startThread !== undefined
        ? await startThread(input, attachments, selections, shared.context, personaOrder)
        : await send(input, undefined, {
            appContext: shared.context,
            attachments,
            selections,
            ...(personaOrder !== undefined && { personaOrder }),
          })
    if (sent) shared.clear()
    return sent
  }

/** Why a conversation takes no message: the owner closed it, or, for a subagent, its job was done. */
function ClosedNotice({ by, onReopen }: { readonly by: 'owner' | 'done'; readonly onReopen: () => void }) {
  return (
    <div className="chat-closed" role="status">
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
  active,
  presence,
  usage,
  context,
  onError,
}: {
  readonly id: string
  readonly presence: ReturnType<typeof presenceOf>
  readonly usage: UsageToday | undefined
  readonly context: number | undefined
  readonly active: boolean
  /** Hears why the models could not be read, or a pick failed. */
  readonly onError: (message: string) => void
}) {
  const choice = useQuery(modelQuery).data
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <PresenceOrb state={presence.state} label={presence.label} active={active} />
        <span className="truncate">{presence.label}</span>
      </span>
      <ModelPicker onError={onError} />
      <SetupButton chat={id} />
      <UsageIndicator
        usage={usage}
        context={context}
        contextWindow={choice?.options.find((option) => option.id === choice.current)?.contextWindow}
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
  queue,
  onRemove,
}: {
  readonly queue: Parameters<typeof QueuedMessages>[0]['inputs']
  readonly notices: readonly string[]
  readonly open: boolean
  readonly waiting: ReturnType<typeof openInteractions>
  readonly id: string
  readonly onAnswer: Parameters<typeof InteractionCards>[0]['onAnswer']
  readonly onRemove: (id: number) => Promise<boolean>
}) {
  return (
    <div className="dock-cards">
      {notices.map((text, index) => (
        <Notice key={`${index}:${text}`} text={text} />
      ))}
      <QueuedMessages inputs={queue} onRemove={onRemove} />
      {open && (
        <>
          <InteractionCards interactions={waiting} thread={id} onAnswer={onAnswer} />
          <SharedContextChips conversation={id} />
        </>
      )}
    </div>
  )
}

/** The dock's live state, derived together so its composer and cards agree. */
function useDockStatus(conversation: ReturnType<typeof useConversation>, parts: readonly Part[]) {
  const { projection, status } = conversation
  const running = projection?.running ?? false
  const usage = useQuery(usageQuery).data
  const asked = useMemo(() => openInteractions(parts), [parts])
  // A stored ask (a held call, a URL request) stays until its store says it ended; only a pending one waits on you.
  const states = useStoredStates(asked)
  const waiting = useMemo(() => stillOpen(asked, states), [asked, states])
  const context = useMemo(() => contextTokens(projection?.messages ?? []), [projection])
  const named = useConnectionLabels()
  const presence = presenceOf({
    status,
    projection,
    parts,
    named,
    waiting: waitingOnOwner(waiting, states),
    exhausted: usage !== undefined && budgetFraction(usage) >= 1,
  })
  return { running, usage, waiting, context, presence }
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
  closed,
  onReopen,
  notices = [],
  placeholder,
  sendLabel,
  active,
  onStartThread,
}: {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly id: string
  /** The owner is working here now: its presence may move. */
  readonly active: boolean
  /** Offers Start thread in the composer, posting the message as a new thread's head this way. */
  readonly onStartThread?: StartThread
  readonly conversation: ReturnType<typeof useConversation>
  readonly parts: readonly Part[]
  /** Who closed it, when it is closed. */
  readonly closed: 'owner' | 'done' | undefined
  readonly onReopen: () => void
  readonly notices?: readonly string[]
  /** What the empty composer says; the default asks the agent. */
  readonly placeholder?: string | undefined
  /** What the send button says; Send by default. */
  readonly sendLabel?: string | undefined
}) {
  const navigation = useNavigation()
  const personas = usePersonas()
  const { projection, notice, send, stop, removeQueued, report } = conversation
  const sendOwn = withSharedContext(useSharedContext(id), send, onStartThread)
  const { running, usage, waiting, context, presence } = useDockStatus(conversation, parts)
  return (
    <div className="chat-dock" ref={ref} data-app-cover>
      <DockCards
        notices={[notice, projection?.queueNotice ?? '', ...notices]}
        open={closed === undefined}
        waiting={waiting}
        id={id}
        onAnswer={send}
        queue={projection?.queued ?? []}
        onRemove={removeQueued}
      />
      {closed !== undefined ? (
        <ClosedNotice by={closed} onReopen={onReopen} />
      ) : (
        <>
          <div className="dock-composer relative">
            {presence.state === 'waiting' && <PresenceBorder />}
            <MessageComposer
              conversation={id}
              onNewThread={(contents) => navigation.newThreadWith(contents, id)}
              onSend={sendOwn}
              personas={personas}
              threads={onStartThread !== undefined}
              attach
              running={running}
              onStop={() => void stop()}
              {...(placeholder !== undefined && { placeholder })}
              {...(sendLabel !== undefined && { sendLabel })}
              context={
                <ComposerContext
                  id={id}
                  active={active}
                  presence={presence}
                  usage={usage}
                  context={context}
                  onError={report}
                />
              }
            />
          </div>
        </>
      )}
    </div>
  )
}
