import { type ReactNode, useState } from 'react'
import { Button, Composer, ComposerActions, ComposerInput } from '@goblin/ui'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import { AttachButton, PendingFiles, useAttachments } from './attachments.tsx'

/** The message field: Enter sends, Shift+Enter breaks the line, and an input method's Enter only composes. */
function Field({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  compact,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSubmit: () => void
  readonly placeholder: string
  readonly disabled: boolean
  readonly compact: boolean
}) {
  return (
    <ComposerInput
      aria-label="Message"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          onSubmit()
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      {...(compact && { className: 'min-h-9 py-1.5' })}
    />
  )
}

/** The compact composer's buttons: Stop while the agent works, and Send. */
function CompactButtons({
  running,
  onStop,
  cannotSend,
}: {
  readonly running: boolean
  readonly onStop: () => void
  readonly cannotSend: boolean
}) {
  return (
    <>
      {running && (
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" onClick={onStop}>
          <SquareIcon />
        </Button>
      )}
      <Button type="submit" size="icon-sm" aria-label="Send" disabled={cannotSend}>
        <ArrowUpIcon />
      </Button>
    </>
  )
}

/**
 * The floating composer. Enter sends, Shift+Enter breaks the line; while the agent works a message queues as a
 * follow-up and Stop is offered. `context` sits on the left of the actions (status, model picker). `attach` offers a
 * paperclip: picked files upload at once and go with the message. `compact` is the one-line composer of a thread
 * unfolded in a transcript: the field and its two buttons, without the context row.
 */
export function MessageComposer({
  onSend,
  running,
  onStop,
  context,
  placeholder = 'Ask your agent…',
  compact = false,
  attach = false,
  sendLabel = 'Send',
}: {
  readonly onSend: (input: string, attachments: readonly string[]) => Promise<boolean>
  readonly running: boolean
  readonly onStop: () => void
  readonly context?: ReactNode
  readonly attach?: boolean
  /** What the empty field says while the agent is idle (while it works it offers a follow-up). */
  readonly placeholder?: string
  readonly compact?: boolean
  /** What the send button says ("Steer" for a subagent). */
  readonly sendLabel?: string
}) {
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const attachments = useAttachments()
  async function submit(): Promise<void> {
    const value = input.trim()
    if (!value || pending || attachments.uploading) return
    setPending(true)
    if (await onSend(value, attachments.paths)) {
      setInput('')
      attachments.clear()
    }
    setPending(false)
  }
  const field = (
    <Field
      value={input}
      onChange={setInput}
      onSubmit={() => void submit()}
      placeholder={running ? 'Add a follow-up…' : placeholder}
      disabled={pending}
      compact={compact}
    />
  )
  const cannotSend = pending || attachments.uploading || !input.trim()
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
          <CompactButtons running={running} onStop={onStop} cannotSend={cannotSend} />
        </>
      ) : (
        <>
          {attach && <PendingFiles attachments={attachments} />}
          {field}
          <ComposerActions>
            {attach && <AttachButton attachments={attachments} />}
            <div className="composer-context mr-auto flex min-w-0 items-center gap-2">{context}</div>
            {running && (
              <Button type="button" variant="outline" onClick={onStop}>
                Stop
              </Button>
            )}
            <Button type="submit" disabled={cannotSend}>
              {sendLabel}
            </Button>
          </ComposerActions>
        </>
      )}
    </Composer>
  )
}
