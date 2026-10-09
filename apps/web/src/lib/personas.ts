import type { ComposerOption, PersonaView } from '@goblin/contracts'

/** The Personas that answer: every one not archived, by name. */
export const activePersonas = (personas: readonly PersonaView[] | undefined): readonly PersonaView[] =>
  (personas ?? [])
    .filter((persona) => persona.archivedAt === undefined)
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** A Persona as the composer's `@` picker offers it: its name, and its role as the line under it. */
export const personaOption = (persona: PersonaView): ComposerOption => ({
  selection: { kind: 'persona', personaId: persona.id },
  label: persona.name,
  description: persona.role,
})

/** How many Personas a draft tags: with two or more the owner chooses whether they answer together or in turn. */
export const taggedPersonas = (selected: readonly ComposerOption[]): number =>
  selected.filter((option) => option.selection.kind === 'persona').length
