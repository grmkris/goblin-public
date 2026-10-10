import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Conflict } from '@goblin/contracts/api'
import { MessageSquareShareIcon } from 'lucide-react'
import { moveMutation } from '../../conversations/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { withRef } from '../../lib/refusal.ts'
import { usePanel } from './panel.tsx'

/** Move to thread in a channel: the message it is offered on, why it cannot move, and the move itself. */
export type Mover = {
  /** The owner's newest message, the only one whose turn can move. */
  readonly entry: number
  /** Its reply is still streaming: the action waits for it to finish. */
  readonly waiting: boolean
  /** Why the runtime refused to move it, in one short line under the message. */
  readonly refusal: string | undefined
  readonly move: () => void
}

/** What the owner reads for each reason the runtime refuses a move. */
const REASONS: Readonly<Record<string, string>> = {
  streaming: 'It can move once the reply has finished.',
  not_latest: 'Only the newest turn can move.',
  moved: 'It is in a thread already.',
  not_user_message: 'Only your own messages can move.',
  not_conversation: 'Only a channel’s turns can move.',
  awaiting_approval: 'It can move once you answer what it asks.',
}

/** A refused move's reason, or what went wrong asking for it, in one short line. */
function refusalText(failure: unknown): string {
  if (failure instanceof Conflict) return withRef('A move of this turn is under way.', failure)
  return messageOf(failure, 'move it')
}

/**
 * Move to thread on a channel's newest finished owner turn (`POST …/move`, ADR 0034): the message stays as the
 * thread's head, the turn goes to the thread, and the thread opens in the panel. While the reply streams the action
 * waits; a refusal shows its reason until the turn changes (a `streaming` one until the run ends).
 */
export function useMover(chat: string, offered: boolean, running: boolean, entry: number | undefined) {
  const panel = usePanel()
  const moving = useMutation(moveMutation).mutate
  const [refused, setRefused] = useState<{ readonly entry: number; readonly reason: string }>()
  return useMemo((): Mover | undefined => {
    if (!offered || entry === undefined) return undefined
    // A `streaming` refusal lasts until the run ends; while it runs, `waiting` says the same.
    const current = refused?.entry === entry && (refused.reason !== 'streaming' || running)
    const reason = current ? refused.reason : undefined
    return {
      entry,
      waiting: running,
      refusal: reason === undefined ? undefined : (REASONS[reason] ?? reason),
      move: () =>
        moving(
          { id: chat, move: { entry, operationId: crypto.randomUUID() } },
          {
            onSuccess: (receipt) => {
              if (receipt.state === 'refused') setRefused({ entry, reason: receipt.reason ?? 'refused' })
              else if (receipt.thread !== undefined) panel.open(receipt.thread)
            },
            onError: (failure) => setRefused({ entry, reason: refusalText(failure) }),
          },
        ),
    }
  }, [offered, entry, running, refused, chat, panel, moving])
}

/** The message pill's Move to thread: unavailable, with its reason, while the turn cannot move. */
export function MoveAction({ mover }: { readonly mover: Mover }) {
  const why = mover.refusal ?? (mover.waiting ? REASONS.streaming : undefined)
  return (
    <button
      type="button"
      className="message-action"
      aria-label="Move to thread"
      title={why ?? 'Move to thread'}
      disabled={why !== undefined}
      onClick={mover.move}
    >
      <MessageSquareShareIcon aria-hidden />
    </button>
  )
}
