import { useEffect, useMemo, useState } from 'react'
import { MessageSquareShareIcon } from 'lucide-react'
import { failureText } from '../../lib/boundary.ts'
import { hasFeature, lacks, missing } from '../../lib/features.ts'
import { usePanel } from './panel.tsx'
import { moveToThread } from './thread-start.ts'

/** Move to thread for a channel's messages: whether it is offered, why it is refused, and the move itself. */
export type Mover = {
  /** Why the message at `entry` cannot move now (the runtime's reason, such as `streaming`), if it cannot. */
  readonly refusal: (entry: number) => string | undefined
  readonly move: (entry: number) => void
}

/** What the owner reads for a refused move. */
const REASONS: Readonly<Record<string, string>> = {
  streaming: 'It can move once the reply has finished.',
  not_latest: 'Only the newest turn can move.',
}

/**
 * Move to thread in a channel, where the server has the route: the owner's message stays as the thread's head and the
 * turn it started goes on in the thread, which opens in the panel. A refusal disables it for that message, with the
 * reason, until the chat's run ends (a `streaming` refusal) or the page reloads.
 */
export function useMover(chat: string, offered: boolean, running: boolean): Mover | undefined {
  const panel = usePanel()
  const [available, setAvailable] = useState(false)
  const [refused, setRefused] = useState<ReadonlyMap<number, string>>(new Map())
  useEffect(() => {
    if (!offered) return
    let current = true
    void hasFeature('move', chat).then((has) => current && setAvailable(has))
    return () => {
      current = false
    }
  }, [chat, offered])
  useEffect(() => {
    if (!running) setRefused((now) => new Map([...now].filter(([, reason]) => reason !== 'streaming')))
  }, [running])
  return useMemo(() => {
    if (!offered || !available) return undefined
    const refuse = (entry: number, reason: string) => setRefused((now) => new Map(now).set(entry, reason))
    return {
      refusal: (entry) => {
        const reason = refused.get(entry)
        return reason === undefined ? undefined : (REASONS[reason] ?? reason)
      },
      move: (entry) => {
        // @effect-diagnostics-next-line cryptoRandomUUID:off -- A fresh move; the runtime keeps one per turn.
        moveToThread(chat, entry, crypto.randomUUID()).then(
          (receipt) => {
            if (receipt.state === 'refused') refuse(entry, receipt.reason ?? 'refused')
            else if (receipt.thread !== undefined) panel.open(receipt.thread)
          },
          (failure: unknown) => {
            if (missing(failure)) {
              lacks('move')
              setAvailable(false)
            } else refuse(entry, failureText(failure))
          },
        )
      },
    }
  }, [offered, available, refused, chat, panel])
}

/** The message pill's Move to thread: disabled with the reason while the runtime refuses it. */
export function MoveAction({ mover, entry }: { readonly mover: Mover; readonly entry: number }) {
  const refusal = mover.refusal(entry)
  return (
    <button
      type="button"
      className="message-action"
      aria-label="Move to thread"
      title={refusal ?? 'Move to thread'}
      disabled={refusal !== undefined}
      onClick={() => mover.move(entry)}
    >
      <MessageSquareShareIcon aria-hidden />
    </button>
  )
}
