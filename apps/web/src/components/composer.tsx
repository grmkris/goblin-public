import { type ReactNode, useMemo } from 'react'
import { type PersonaView, selectionKey } from '@goblin/contracts'
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
import { ArrowUpIcon, CircleHelpIcon, MessageSquarePlusIcon, SquareIcon, XIcon } from 'lucide-react'
import { sendsMessage } from '../lib/keys.ts'
import { activePersonas, personaOption, taggedPersonas } from '../lib/personas.ts'
import { AttachButton, PendingFiles } from './attachments.tsx'
import { ComposerPicker, useComposerPicker } from './composer-picker.tsx'
import { type ComposerProps, useComposer } from './composer-state.ts'
import { PersonaAvatar } from './persona-avatar.tsx'

type Props = ComposerProps & {
  readonly running: boolean
  readonly context?: ReactNode
  readonly attach?: boolean
  readonly placeholder?: string
  readonly compact?: boolean
  readonly sendLabel?: string
  readonly autoFocus?: boolean
  /** The owner's Personas, offered as `@` references when the server has them. */
  readonly personas?: readonly PersonaView[] | undefined
}

function SelectionChips({
  state,
  personas,
}: {
  readonly state: ReturnType<typeof useComposer>
  readonly personas: readonly PersonaView[]
}) {
  if (state.selected.length === 0) return null
  return (
    <ul className="composer-selections" aria-label="Selected references">
      {state.selected.map((option) => {
        const failed = state.failed === selectionKey(option.selection)
        const { selection } = option
        const persona =
          selection.kind === 'persona' ? personas.find((each) => each.id === selection.personaId) : undefined
        return (
          <li key={selectionKey(selection)} data-failed={failed || undefined} data-kind={selection.kind}>
            {persona !== undefined && <PersonaAvatar avatar={persona.avatar} size="sm" />}
            <span>
              {selection.kind === 'skill' ? '/' : '@'}
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

/** With two or more Personas tagged: whether they answer together, or one after another in the order tagged. */
function PersonaOrder({ state }: { readonly state: ReturnType<typeof useComposer> }) {
  if (taggedPersonas(state.selected) < 2) return null
  const choice = (value: 'parallel' | 'sequence', label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={state.order === value}
      className="composer-order-choice"
      onClick={() => state.setOrder(value)}
    >
      {label}
    </button>
  )
  return (
    <div className="composer-order" role="radiogroup" aria-label="How the personas answer">
      {choice('parallel', 'Together')}
      {choice('sequence', 'In turn')}
    </div>
  )
}

/** While Start thread is on: the message will start a thread, and × goes back to sending here, the draft kept. */
function ThreadMode({ state }: { readonly state: ReturnType<typeof useComposer> }) {
  if (!state.thread) return null
  return (
    <p className="composer-mode">
      <MessageSquarePlusIcon aria-hidden />
      <span>Starts a thread</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Send here instead"
        onClick={() => state.setThread(false)}
      >
        <XIcon />
      </Button>
    </p>
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
  personas,
  ...props
}: Props) {
  const state = useComposer({ ...props, onStop })
  const offered = useMemo(() => activePersonas(personas), [personas])
  const extra = useMemo(() => offered.map(personaOption), [offered])
  const picker = useComposerPicker(props.conversation, state.selected, state.choose, extra)
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
      <ThreadMode state={state} />
      <SelectionChips state={state} personas={offered} />
      <PersonaOrder state={state} />
      {attach && <PendingFiles attachments={state.attachments} />}
      <ComposerField
        state={state}
        picker={picker}
        compact={compact}
        running={running}
        placeholder={state.thread ? 'Start a thread…' : placeholder}
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
          {props.threads === true && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Start a thread"
              title="Start a thread"
              aria-pressed={state.thread}
              onClick={() => state.setThread(!state.thread)}
            >
              <MessageSquarePlusIcon />
            </Button>
          )}
          <ComposerHelp state={state} />
          <div className="composer-context mr-auto flex min-w-0 items-center gap-2">{context}</div>
          {running && (
            <Button type="button" variant="outline" onClick={onStop}>
              Stop
            </Button>
          )}
          <Button type="submit" disabled={state.cannotSend}>
            {state.thread ? 'Start thread' : sendLabel}
          </Button>
        </ComposerActions>
      )}
    </Composer>
  )
}
