import { type ComposerOption, type ComposerSelection, selectionKey } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import type { AttachmentDraft } from './attachment-draft.ts'

export type ComposerDraft = {
  readonly text: string
  readonly selections: readonly ComposerOption[]
  readonly attachments: AttachmentDraft
}
export type Trigger = {
  readonly prefix: '/' | '@'
  readonly query: string
  readonly start: number
  readonly end: number
}
export type Command = 'help' | 'new-thread' | 'stop'
export type PickerItem =
  | { readonly kind: 'command'; readonly command: Command; readonly label: string; readonly description: string }
  | ({ readonly kind: 'reference' } & ComposerOption)
const COMMANDS: readonly PickerItem[] = [
  { kind: 'command', command: 'help', label: 'help', description: 'How commands and references work' },
  { kind: 'command', command: 'new-thread', label: 'new-thread', description: 'Move this draft into a fresh thread' },
  { kind: 'command', command: 'stop', label: 'stop', description: 'Stop work in this conversation now' },
]

/** Only a token at the caret opens a picker. Email addresses, paths and literal text remain untouched. */
export function composerTrigger(input: string, start: number, end = start): Trigger | undefined {
  if (start !== end) return undefined
  const match = /(?:^|\s)([/@])([^\s/@]*)$/u.exec(input.slice(0, start))
  const prefix = match?.[1]
  if (prefix !== '/' && prefix !== '@') return undefined
  const query = match?.[2] ?? ''
  return { prefix, query, start: start - query.length - 1, end: start }
}

export function pickerItems(
  trigger: Trigger,
  options: readonly ComposerOption[],
  selected: readonly ComposerOption[],
): readonly PickerItem[] {
  const keys = new Set(selected.map((option) => selectionKey(option.selection)))
  const references: PickerItem[] = (selected.length >= 16 ? [] : options)
    .filter(
      (option) =>
        !keys.has(selectionKey(option.selection)) && (trigger.prefix === '@' || option.selection.kind === 'skill'),
    )
    .map((option) => ({ kind: 'reference', ...option }))
  const query = trigger.query.toLocaleLowerCase()
  return [...(trigger.prefix === '/' ? COMMANDS : []), ...references]
    .filter((option) => `${option.label} ${option.description}`.toLocaleLowerCase().includes(query))
    .slice(0, 40)
}

export function withoutTrigger(input: string, trigger: Trigger): string {
  return input.slice(0, trigger.start) + input.slice(trigger.end)
}
export function canSend(input: string, selections: readonly ComposerOption[]): boolean {
  return input.trim() !== '' || selections.some((option) => option.selection.kind === 'skill')
}
/** The chip a refused send names (`InvalidInput` with reason `composer:<key>`), if it names one. */
export function selectionFailure(error: unknown, selections: readonly ComposerSelection[]): string | undefined {
  if (!(error instanceof InvalidInput)) return undefined
  return selections.map(selectionKey).find((key) => error.reason === `composer:${key}`)
}
