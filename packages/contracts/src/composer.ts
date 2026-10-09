import * as Schema from 'effect/Schema'
import { PersonaId } from './ids.ts'

const Server = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
export const ComposerSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('connection'), serverId: Server }),
  Schema.Struct({
    kind: Schema.Literal('skill'),
    serverId: Server,
    uri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    kind: Schema.Literal('subagent'),
    conversationId: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)),
  }),
  /** `@Persona`: this Persona answers the message, with attribution, instead of Goblin. */
  Schema.Struct({ kind: Schema.Literal('persona'), personaId: PersonaId }),
])
export type ComposerSelection = typeof ComposerSelection.Type
export const ComposerSelections = Schema.Array(ComposerSelection).check(Schema.isMaxLength(16))

/** Labels are resolved by the runtime, never supplied with submissions. */
export const ComposerOption = Schema.Struct({
  selection: ComposerSelection,
  label: Schema.String,
  description: Schema.String,
})
export type ComposerOption = typeof ComposerOption.Type
export const ComposerOptions = Schema.Struct({
  options: Schema.Array(ComposerOption),
  unavailable: Schema.Array(Schema.String),
})
export type ComposerOptions = typeof ComposerOptions.Type
export const ComposerMetadata = Schema.Struct({
  composer: Schema.Struct({
    text: Schema.String,
    selections: Schema.Array(ComposerOption),
    context: Schema.optional(Schema.Unknown),
  }),
})
export type ComposerMetadata = typeof ComposerMetadata.Type

/** Identity key shared by chips and selection-specific errors. */
export const selectionKey = (selection: ComposerSelection): string => {
  switch (selection.kind) {
    case 'connection':
      return `connection:${selection.serverId}`
    case 'skill':
      return `skill:${selection.serverId}:${selection.uri}`
    case 'subagent':
      return `subagent:${selection.conversationId}`
    case 'persona':
      return `persona:${selection.personaId}`
  }
}
