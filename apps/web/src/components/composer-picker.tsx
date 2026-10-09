import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { type ComposerOption, ComposerOptions, selectionKey } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { composerTrigger, pickerItems, type PickerItem, type Trigger } from '../lib/composer.ts'
import { failureText, request } from '../lib/boundary.ts'

const decode = Schema.decodeUnknownSync(ComposerOptions)

function useCatalog(
  conversation: string,
  open: boolean,
  setCatalog: (catalog: ComposerOptions) => void,
  setError: (error: string) => void,
  setLoading: (loading: boolean) => void,
) {
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setCatalog({ options: [], unavailable: [] })
    setLoading(true)
    setError('')
    request(`/api/conversations/${conversation}/composer`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setCatalog(decode(data))
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failureText(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [conversation, open])
}

/** The `/` and `@` picker of a composer: the conversation's references (Personas among them) from the server. */
export function useComposerPicker(
  conversation: string,
  selected: readonly ComposerOption[],
  choose: (item: PickerItem, trigger: Trigger) => void,
) {
  const [trigger, setTrigger] = useState<Trigger>()
  const [catalog, setCatalog] = useState<Schema.Schema.Type<typeof ComposerOptions>>({ options: [], unavailable: [] })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const open = trigger !== undefined
  useCatalog(conversation, open, setCatalog, setError, setLoading)
  const items = useMemo(() => {
    if (trigger === undefined) return []
    return pickerItems(trigger, catalog.options, selected)
  }, [trigger, catalog.options, selected])
  const index = Math.min(active, Math.max(0, items.length - 1))
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])
  const update = (field: HTMLTextAreaElement) => {
    setTrigger(composerTrigger(field.value, field.selectionStart, field.selectionEnd))
    setActive(0)
  }
  const select = (item: PickerItem) => {
    if (trigger !== undefined) choose(item, trigger)
    setTrigger(undefined)
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing || trigger === undefined) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setTrigger(undefined)
      return true
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length > 0) {
      event.preventDefault()
      setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      return true
    }
    const item = items[index]
    if ((event.key === 'Enter' || event.key === 'Tab') && item !== undefined) {
      event.preventDefault()
      select(item)
      return true
    }
    return false
  }
  return {
    id,
    list,
    items,
    index,
    open,
    error,
    loading,
    unavailable: catalog.unavailable,
    update,
    select,
    keyDown,
    close: () => setTrigger(undefined),
  }
}

export function ComposerPicker({ picker }: { readonly picker: ReturnType<typeof useComposerPicker> }) {
  if (!picker.open) return null
  return (
    <div className="composer-picker" onPointerDown={(event) => event.preventDefault()}>
      <div
        className="composer-picker-list"
        id={picker.id}
        role="listbox"
        aria-label="Commands and references"
        ref={picker.list}
      >
        {picker.items.map((item, index) => (
          <button
            type="button"
            id={`${picker.id}-${index}`}
            key={item.kind === 'command' ? item.command : selectionKey(item.selection)}
            role="option"
            aria-selected={index === picker.index}
            onClick={() => picker.select(item)}
          >
            <span className="composer-picker-title">
              {item.kind === 'command' ? '/' : item.selection.kind === 'skill' ? '/' : '@'}
              {item.label}
              <small>{item.kind === 'command' ? 'Command' : item.selection.kind}</small>
            </span>
            <span className="composer-picker-detail">{item.description}</span>
          </button>
        ))}
      </div>
      {picker.loading && <p role="status">Loading references…</p>}
      {picker.error !== '' && <p role="status">{picker.error}</p>}
      {!picker.loading && picker.error === '' && picker.items.length === 0 && (
        <p role="status">No matches. Your text can still be sent.</p>
      )}
      {picker.unavailable.length > 0 && <p role="status">Some skill libraries are unavailable.</p>}
    </div>
  )
}
