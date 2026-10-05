import { type ReactNode, useState } from 'react'
import { Button, Composer, ComposerActions, ComposerInput } from '@purrable/ui'

/**
 * The floating composer. Enter sends, Shift+Enter breaks the line; while the agent works a message queues as a
 * follow-up and Stop is offered. `context` sits on the left of the actions (status, model picker).
 */
export function MessageComposer({
  onSend,
  running,
  onStop,
  context,
  placeholder = 'Ask your agent…',
}: {
  readonly onSend: (input: string) => Promise<boolean>
  readonly running: boolean
  readonly onStop: () => void
  readonly context: ReactNode
  /** What the empty field says while the agent is idle (while it works it offers a follow-up). */
  readonly placeholder?: string
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
  return (
    <Composer
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
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
      />
      <ComposerActions>
        <div className="mr-auto flex min-w-0 items-center gap-2">{context}</div>
        {running && (
          <Button type="button" variant="outline" onClick={onStop}>
            Stop
          </Button>
        )}
        <Button type="submit" disabled={pending || !input.trim()}>
          Send
        </Button>
      </ComposerActions>
    </Composer>
  )
}
