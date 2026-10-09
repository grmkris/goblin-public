import type { ComposerOption, PersonaView } from '@goblin/contracts'

/** The Personas that answer: every one not archived, by name. */
export const activePersonas = (personas: readonly PersonaView[]): readonly PersonaView[] =>
  personas
    .filter((persona) => persona.archivedAt === undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** How many Personas a draft tags: with two or more the owner chooses whether they answer together or in turn. */
export const taggedPersonas = (selected: readonly ComposerOption[]): number =>
  selected.filter((option) => option.selection.kind === 'persona').length
