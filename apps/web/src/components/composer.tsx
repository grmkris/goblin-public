import { type ReactNode } from 'react'
import { selectionKey } from '@goblin/contracts'
import {
  Button,
  Composer,
  ComposerActions,
  ComposerInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useMediaQuery,
} from '@goblin/ui'
import { ArrowUpIcon, CircleHelpIcon, SquareIcon, XIcon } from 'lucide-react'
import { sendsMessage } from '../lib/keys.ts'
import { AttachButton, PendingFiles } from './attachments.tsx'
import { ComposerPicker, useComposerPicker } from './composer-picker.tsx'
import { type ComposerProps, useComposer } from './composer-state.ts'

type Props = ComposerProps & {
  readonly running: boolean
  readonly context?: ReactNode
  readonly attach?: boolean
  readonly placeholder?: string
  readonly compact?: boolean
  readonly sendLabel?: string
  readonly autoFocus?: boolean
}

function SelectionChips({ state }: { readonly state: ReturnType<typeof useComposer> }) {
  if (state.selected.length === 0) return null
  return (
    <ul className="composer-selections" aria-label="Selected references">
      {state.selected.map((option) => {
        const failed = state.failed === selectionKey(option.selection)
        return (
          <li key={selectionKey(option.selection)} data-failed={failed || undefined}>
            <span>
              {option.selection.kind === 'skill' ? '/' : '@'}
              {option.label}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${option.label}`}
              disabled={state.pending}
              onClick={() => state.remove(option)}
            >
              <XIcon />
            </Button>
            {failed && <span role="alert">Unavailable. Remove it or retry.</span>}
          </li>
        )
      })}
    </ul>
  )
}

function ComposerHelp({ state }: { readonly state: ReturnType<typeof useComposer> }) {
  return (
    <Popover open={state.help} onOpenChange={state.setHelp}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Composer help" />}>
        <CircleHelpIcon />
      </PopoverTrigger>
      <PopoverContent side="top" className="max-w-sm">
        <p className="font-medium">Commands and references</p>
        <p>Use / to pick skills, /help, /new-thread or /stop. Use @ to pick a connection, skill or helper.</p>
        <p>
          A selected skill runs with your message. Connection hints grant no permissions. Helper references bring their
          latest report here.
        </p>
        <p>
          Arrow keys browse; Enter or Tab selects; Escape dismisses. Text you type without selecting stays ordinary
          prose.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function ComposerField({
  state,
  picker,
  compact,
  running,
  placeholder,
  autoFocus,
  onStop,
}: {
  readonly state: ReturnType<typeof useComposer>
  readonly picker: ReturnType<typeof useComposerPicker>
  readonly compact: boolean
  readonly running: boolean
  readonly placeholder: string
  readonly autoFocus: boolean
  readonly onStop: () => void
}) {
  const touch = useMediaQuery('(pointer: coarse), (any-pointer: coarse)')
  return (
    <div className={compact ? 'flex items-end gap-1' : undefined}>
      <ComposerInput
        aria-label="Message"
        value={state.input}
        readOnly={state.pending}
        aria-busy={state.pending}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={picker.open}
        aria-controls={picker.open ? picker.id : undefined}
        aria-activedescendant={picker.open && picker.items.length > 0 ? `${picker.id}-${picker.index}` : undefined}
        placeholder={running ? 'Add a follow-up…' : placeholder}
        enterKeyHint={touch ? 'enter' : 'send'}
        onChange={(event) => {
          state.setInput(event.target.value)
          picker.update(event.currentTarget)
        }}
        onClick={(event) => picker.update(event.currentTarget)}
        onCompositionEnd={(event) => picker.update(event.currentTarget)}
        onBlur={picker.close}
        onKeyDown={(event) => {
          if (picker.keyDown(event)) return
          if (sendsMessage({ ...event, isComposing: event.nativeEvent.isComposing }, touch)) {
            event.preventDefault()
            picker.close()
            void state.submit()
          }
        }}
        {...(compact && { className: 'min-h-9 py-1.5' })}
      />
      {compact && (
        <>
          <ComposerHelp state={state} />
          {running && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" onClick={onStop}>
              <SquareIcon />
            </Button>
          )}
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={state.cannotSend}>
            <ArrowUpIcon />
          </Button>
        </>
      )}
    </div>
  )
}

/** One native textarea and one reference picker across panes, drafts and compact inline replies. */
export function MessageComposer({
  running,
  onStop,
  context,
  placeholder = 'Ask your agent…',
  compact = false,
  attach = false,
  sendLabel = 'Send',
  autoFocus = false,
  ...props
}: Props) {
  const state = useComposer({ ...props, onStop })
  const picker = useComposerPicker(props.conversation, state.selected, state.choose)
  return (
    <Composer
      ref={state.form}
      className="relative"
      onSubmit={(event) => {
        event.preventDefault()
        picker.close()
        void state.submit()
      }}
    >
      <ComposerPicker picker={picker} />
      <SelectionChips state={state} />
      {attach && <PendingFiles attachments={state.attachments} />}
      <ComposerField
        state={state}
        picker={picker}
        compact={compact}
        running={running}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onStop={onStop}
      />
      {state.error !== '' && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {state.error}
        </p>
      )}
      {!compact && (
        <ComposerActions>
          {attach && <AttachButton attachments={state.attachments} />}
          <ComposerHelp state={state} />
          <div className="composer-context mr-auto flex min-w-0 items-center gap-2">{context}</div>
          {running && (
            <Button type="button" variant="outline" onClick={onStop}>
              Stop
            </Button>
          )}
          <Button type="submit" disabled={state.cannotSend}>
            {sendLabel}
          </Button>
        </ComposerActions>
      )}
    </Composer>
  )
}
