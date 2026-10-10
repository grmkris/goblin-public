// Owner-only messages in a chat ("Only visible to you"): suggestions the owner can act on or dismiss, never part of
// the transcript (`EphemeralMessage`). The slot and its provider are here; decision proposals fill them (`decisions/`).
import { type ReactNode, createContext, use } from 'react'
import type { EphemeralMessage } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { EyeIcon, XIcon } from 'lucide-react'
import { type DecisionRows, useDecisionRows } from '../../decisions/hooks.ts'

const EphemeralContext = createContext<DecisionRows>({ of: () => [], act: () => undefined, dismiss: () => undefined })

/**
 * Gives the chats below their owner-only messages: the open decision proposals, each in its chat. Acting on one or
 * dismissing it takes it away at once, and a choice the runtime refused brings it back.
 */
export function EphemeralProvider({ children }: { readonly children: ReactNode }) {
  return <EphemeralContext value={useDecisionRows()}>{children}</EphemeralContext>
}

/** The owner-only messages of `chat`, and what the owner can do with them. */
export function useEphemeral(chat: string) {
  const ephemeral = use(EphemeralContext)
  return { messages: ephemeral.of(chat), act: ephemeral.act, dismiss: ephemeral.dismiss }
}

const VARIANT = { primary: 'default', neutral: 'outline', danger: 'destructive' } as const

/** One owner-only message: who sees it, its title and words, its actions, and Dismiss. */
export function EphemeralRow({
  message,
  onAction,
  onDismiss,
}: {
  readonly message: EphemeralMessage
  readonly onAction: (action: string) => void
  readonly onDismiss: () => void
}) {
  return (
    <aside className="ephemeral" aria-label={message.title}>
      <p className="ephemeral-who">
        <EyeIcon aria-hidden />
        Only visible to you
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      </p>
      <p className="ephemeral-title">{message.title}</p>
      <p className="ephemeral-body">{message.body}</p>
      {message.actions.length > 0 && (
        <div className="ephemeral-actions">
          {message.actions.map((action) => (
            <Button key={action.id} size="sm" variant={VARIANT[action.tone]} onClick={() => onAction(action.id)}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </aside>
  )
}
