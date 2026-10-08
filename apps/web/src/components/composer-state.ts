import { useEffect, useRef, useState } from 'react'
import { type ComposerOption, type ComposerSelection, selectionKey } from '@goblin/contracts'
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

export type ComposerProps = {
  readonly onSend: (
    input: string,
    attachments: readonly string[],
    selections: readonly ComposerSelection[],
  ) => Promise<boolean>
  readonly onStop: () => void
  readonly conversation: string
  readonly onNewThread: (draft: ComposerDraft) => void
  readonly draft?:
    | {
        readonly text: string
        readonly selections?: readonly ComposerOption[]
        readonly attachments?: ComposerDraft['attachments']
      }
    | undefined
}

export function useComposer(props: ComposerProps) {
  const [input, setInput] = useState(props.draft?.text ?? '')
  const [selected, setSelected] = useState<readonly ComposerOption[]>(props.draft?.selections ?? [])
  const [pending, setPending] = useState(false)
  const [help, setHelp] = useState(false)
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<string>()
  const form = useRef<HTMLFormElement>(null)
  const attachments = useAttachments(props.draft?.attachments)
  useEffect(() => {
    if (props.draft === undefined) return
    setInput(props.draft.text)
    if (props.draft.selections !== undefined) setSelected(props.draft.selections)
    form.current?.querySelector('textarea')?.focus()
  }, [props.draft])
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
      if (await props.onSend(input.trim(), attachments.paths, selections)) {
        clear()
        attachments.clear()
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
    if (item.kind === 'reference') {
      setSelected((current) => [...current, item])
      setInput(text)
    } else if (item.command === 'new-thread') {
      props.onNewThread({ text, selections: selected, attachments: attachments.detach() })
      clear()
    } else {
      setInput(text)
      if (item.command === 'help') setHelp(true)
      else props.onStop()
    }
    if (item.kind !== 'command' || item.command !== 'new-thread') form.current?.querySelector('textarea')?.focus()
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
    cannotSend: pending || attachments.uploading || attachments.failed || !canSend(input, selected),
  }
}
