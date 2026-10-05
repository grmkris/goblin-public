import { type ReactNode, useState } from 'react'
import { Button, Composer, ComposerActions, ComposerInput } from '@purrable/ui'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'

/**
 * The floating composer. Enter sends, Shift+Enter breaks the line; while the agent works a message queues as a
 * follow-up and Stop is offered. `context` sits on the left of the actions (status, model picker). `compact` is the
 * one-line composer of a thread unfolded in a transcript: the field and its two buttons, without the context row.
 */
export function MessageComposer({
  onSend,
  running,
  onStop,
  context,
  placeholder = 'Ask your agent…',
  compact = false,
}: {
  readonly onSend: (input: string) => Promise<boolean>
  readonly running: boolean
  readonly onStop: () => void
  readonly context?: ReactNode
  /** What the empty field says while the agent is idle (while it works it offers a follow-up). */
  readonly placeholder?: string
  readonly compact?: boolean
}) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(): Promise<void> {
    const value = input.trim()
    if (!value || pending) return
    setPending(true)
    if (await onSend(value)) setInput('')
    setPending(false)
  }
  const field = (
    <ComposerInput
      aria-label="Message"
      value={input}
      onChange={(event) => setInput(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void submit()
        }
      }}
      placeholder={running ? 'Add a follow-up…' : placeholder}
      disabled={pending}
      {...(compact && { className: 'min-h-9 py-1.5' })}
    />
  )
  const cannotSend = pending || !input.trim()
  return (
    <Composer
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      {...(compact && { className: 'flex-row items-end gap-1 rounded-xl p-1' })}
    >
      {compact ? (
        <>
          {field}
          {running && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" onClick={onStop}>
              <SquareIcon />
            </Button>
          )}
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={cannotSend}>
            <ArrowUpIcon />
          </Button>
        </>
      ) : (
        <>
          {field}
          <ComposerActions>
            <div className="composer-context mr-auto flex min-w-0 items-center gap-2">{context}</div>
            {running && (
              <Button type="button" variant="outline" onClick={onStop}>
                Stop
              </Button>
            )}
            <Button type="submit" disabled={cannotSend}>
              Send
            </Button>
          </ComposerActions>
        </>
      )}
    </Composer>
  )
}
