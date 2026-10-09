import { type RefObject, useEffect, useRef, useState } from 'react'
import { type ComposerOption, type ComposerSelection, selectionKey } from '@goblin/contracts'
import { taggedPersonas } from '../lib/personas.ts'
import {
  canSend,
  selectionFailure,
  withoutTrigger,
  type ComposerDraft,
  type PickerItem,
  type Trigger,
} from '../lib/composer.ts'
import { failureText } from '../lib/boundary.ts'
import { useAttachments } from './attachments.tsx'

/**
 * What else a send carries: with two or more Personas tagged, whether they answer together or in turn; and whether the
 * message starts a thread (Start thread), its reply landing there.
 */
export type SendExtras = { readonly personaOrder?: 'parallel' | 'sequence'; readonly thread?: boolean }

export type ComposerProps = {
  readonly onSend: (
    input: string,
    attachments: readonly string[],
    selections: readonly ComposerSelection[],
    extras: SendExtras,
  ) => Promise<boolean>
  readonly onStop: () => void
  readonly conversation: string
  readonly onNewThread: (draft: ComposerDraft) => void
  /** Offers Start thread: the message posts as a new thread's head instead (`/new-thread` turns it on). */
  readonly threads?: boolean
  readonly draft?:
    | {
        readonly text: string
        readonly selections?: readonly ComposerOption[]
        readonly attachments?: ComposerDraft['attachments']
      }
    | undefined
}

/**
 * How a draft is sent beyond its words: with two or more Personas tagged, together or in turn; and whether Start
 * thread is on.
 */
function useSendModes(selected: readonly ComposerOption[]) {
  const [order, setOrder] = useState<'parallel' | 'sequence'>('parallel')
  const [thread, setThread] = useState(false)
  const extras: SendExtras = {
    ...(taggedPersonas(selected) > 1 && { personaOrder: order }),
    ...(thread && { thread: true }),
  }
  return { order, setOrder, thread, setThread, extras }
}

/** What picking an item from the `/` and `@` picker does to the draft; whether the focus stays in its field. */
function pick(
  item: PickerItem,
  text: string,
  props: ComposerProps,
  draft: {
    readonly setInput: (text: string) => void
    readonly setThread: (on: boolean) => void
    readonly setHelp: (open: boolean) => void
    readonly add: (option: ComposerOption) => void
    readonly moveOut: () => void
  },
): boolean {
  if (item.kind === 'reference') {
    draft.add(item)
    draft.setInput(text)
    return true
  }
  if (item.command === 'new-thread' && props.threads !== true) {
    draft.moveOut()
    return false
  }
  draft.setInput(text)
  // With Start thread on offer the draft stays where it is: sending posts it as the new thread's head.
  if (item.command === 'new-thread') draft.setThread(true)
  else if (item.command === 'help') draft.setHelp(true)
  else props.onStop()
  return true
}

/** A draft handed in (a command moved one here) replaces what the composer holds, and the focus goes to it. */
function useDraft(
  draft: ComposerProps['draft'],
  setInput: (text: string) => void,
  setSelected: (selected: readonly ComposerOption[]) => void,
  form: RefObject<HTMLFormElement | null>,
) {
  useEffect(() => {
    if (draft === undefined) return
    setInput(draft.text)
    if (draft.selections !== undefined) setSelected(draft.selections)
    form.current?.querySelector('textarea')?.focus()
  }, [draft, setInput, setSelected, form])
}

export function useComposer(props: ComposerProps) {
  const [input, setInput] = useState(props.draft?.text ?? '')
  const [selected, setSelected] = useState<readonly ComposerOption[]>(props.draft?.selections ?? [])
  const [pending, setPending] = useState(false)
  const [help, setHelp] = useState(false)
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<string>()
  const { order, setOrder, thread, setThread, extras } = useSendModes(selected)
  const form = useRef<HTMLFormElement>(null)
  const attachments = useAttachments(props.draft?.attachments)
  useDraft(props.draft, setInput, setSelected, form)
  const clear = () => {
    setInput('')
    setSelected([])
    setError('')
    setFailed(undefined)
  }
  const submit = async (): Promise<void> => {
    if (!canSend(input, selected) || pending || attachments.uploading || attachments.failed) return
    setPending(true)
    setError('')
    setFailed(undefined)
    const selections = selected.map((option) => option.selection)
    try {
      if (await props.onSend(input.trim(), attachments.paths, selections, extras)) {
        clear()
        attachments.clear()
        setThread(false)
      }
    } catch (failure) {
      setFailed(selectionFailure(failure, selections))
      setError(failureText(failure))
    } finally {
      setPending(false)
    }
  }
  const choose = (item: PickerItem, trigger: Trigger) => {
    if (pending) return
    const text = withoutTrigger(input, trigger)
    const stays = pick(item, text, props, {
      setInput,
      setThread,
      setHelp,
      add: (option) => setSelected((current) => [...current, option]),
      moveOut: () => {
        props.onNewThread({ text, selections: selected, attachments: attachments.detach() })
        clear()
      },
    })
    if (stays) form.current?.querySelector('textarea')?.focus()
  }
  const remove = (option: ComposerOption) => {
    setSelected((current) => current.filter((item) => selectionKey(item.selection) !== selectionKey(option.selection)))
    if (failed === selectionKey(option.selection)) {
      setFailed(undefined)
      setError('')
    }
  }
  return {
    input,
    setInput,
    selected,
    pending,
    help,
    setHelp,
    error,
    failed,
    form,
    attachments,
    submit,
    choose,
    remove,
    order,
    setOrder,
    thread,
    setThread,
    cannotSend: pending || attachments.uploading || attachments.failed || !canSend(input, selected),
  }
}
