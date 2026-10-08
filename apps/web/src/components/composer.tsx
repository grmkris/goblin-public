import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button, Composer, ComposerActions, ComposerInput, useMediaQuery } from '@goblin/ui'
import { sendsMessage } from '../lib/keys.ts'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import { AttachButton, PendingFiles, useAttachments } from './attachments.tsx'

function useDraftValue(
  draft: { readonly text: string } | undefined,
  setInput: (text: string) => void,
  form: React.RefObject<HTMLFormElement | null>,
) {
  useEffect(() => {
    if (draft !== undefined) {
      setInput(draft.text)
      form.current?.querySelector('textarea')?.focus()
    }
  }, [draft, form, setInput])
}

/**
 * The message field. At a keyboard and mouse Enter sends and Shift+Enter breaks the line; on a touch screen Return
 * breaks the line and the Send button sends (⌘/Ctrl+Enter from a hardware keyboard), as `sendsMessage` decides. While a
 * message is on its way the field is read-only, not disabled: disabling it would take the focus, and with it close a
 * phone's keyboard after every message.
 */
function Field({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy,
  compact,
  autoFocus,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSubmit: () => void
  readonly placeholder: string
  readonly busy: boolean
  readonly compact: boolean
  readonly autoFocus: boolean
}) {
  const touch = useMediaQuery('(pointer: coarse)')
  return (
    <ComposerInput
      aria-label="Message"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (sendsMessage({ ...event, isComposing: event.nativeEvent.isComposing }, touch)) {
          event.preventDefault()
          onSubmit()
        }
      }}
      placeholder={placeholder}
      enterKeyHint={touch ? 'enter' : 'send'}
      autoFocus={autoFocus}
      readOnly={busy}
      aria-busy={busy}
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

type MessageComposerProps = {
  readonly onSend: (input: string, attachments: readonly string[]) => Promise<boolean>
  readonly running: boolean
  readonly onStop: () => void
  readonly context?: ReactNode
  readonly attach?: boolean
  /** What the empty field says while the agent is idle (while it works it offers a follow-up). */
  readonly placeholder?: string
  readonly compact?: boolean
  /** What the send button says ("Steer" for a subagent). */
  readonly draft?: { readonly text: string } | undefined
  readonly sendLabel?: string
  /** Take the focus when it appears: a composer the owner just asked for (Reply in thread) is where they type next. */
  readonly autoFocus?: boolean
}

/**
 * The floating composer. Enter sends (on a touch screen the Send button does, and Return breaks the line); while the
 * agent works a message queues as a follow-up and Stop is offered. `context` sits on the left of the actions (status,
 * model picker). `attach` offers a paperclip: picked files upload at once and go with the message. `compact` is the
 * one-line composer of a thread unfolded in a transcript: the field and its two buttons, without the context row.
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
  draft,
  autoFocus = false,
}: MessageComposerProps) {
  const [input, setInput] = useState('')
  const form = useRef<HTMLFormElement>(null)
  useDraftValue(draft, setInput, form)
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
      busy={pending}
      compact={compact}
      autoFocus={autoFocus}
    />
  )
  const cannotSend = pending || attachments.uploading || !input.trim()
  return (
    <Composer
      ref={form}
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
