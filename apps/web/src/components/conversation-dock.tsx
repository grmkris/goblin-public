import { type RefObject, useMemo } from 'react'
import type { AppContext } from '@purrable/contracts'
import { Alert, AlertDescription, Button, PresenceBorder, PresenceOrb } from '@purrable/ui'
import { RotateCcwIcon } from 'lucide-react'
import { openInteractions } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { budgetFraction, contextTokens } from '../lib/usage.ts'
import { SharedContextChips, useSharedContext } from './apps/offers.tsx'
import { CapabilitiesButton } from './capabilities.tsx'
import { MessageComposer } from './composer.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { ModelPicker, type useModelChoice } from './model-picker.tsx'
import { UsageIndicator } from './usage-indicator.tsx'
import type { useConversation } from './use-conversation.ts'
import { useUsageToday } from './use-usage.ts'

type Send = (input: string, operationId?: string, appContext?: readonly AppContext[]) => Promise<boolean>

export function Notice({ text }: { readonly text: string }) {
  if (text === '') return null
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/** The owner's message, with what the conversation's Apps share; shared context is sent once, then cleared. */
export function useSendWithAppContext(conversation: string, send: Send): (input: string) => Promise<boolean> {
  const shared = useSharedContext(conversation)
  return async (input) => {
    const sent = await send(input, undefined, shared.context)
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
}: {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly id: string
  readonly conversation: ReturnType<typeof useConversation>
  readonly model: ReturnType<typeof useModelChoice>
  readonly parts: readonly Part[]
  /** Who closed it, when it is closed. */
  readonly closed: 'owner' | 'done' | undefined
  readonly onReopen: () => void
  readonly notices?: readonly string[]
}) {
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
      <Notice text={notice} />
      {notices.map((text) => (
        <Notice key={text} text={text} />
      ))}
      {closed !== undefined ? (
        <ClosedNotice by={closed} onReopen={onReopen} />
      ) : (
        <>
          <InteractionCards interactions={waiting} thread={id} onAnswer={send} />
          <SharedContextChips conversation={id} />
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
                  <ModelPicker choice={model.choice} onChoose={(picked) => void model.choose(picked)} />
                  <CapabilitiesButton thread={id} running={running} />
                  <UsageIndicator
                    usage={usage}
                    context={context}
                    contextWindow={
                      model.choice?.options.find((option) => option.id === model.choice?.current)?.contextWindow
                    }
                  />
                </>
              }
            />
          </div>
        </>
      )}
    </div>
  )
}
