import { useQuery } from '@tanstack/react-query'
import { type ModelChoice, NOTHING, type PersonaDefinition } from '@goblin/contracts'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from '@goblin/ui'
import { modelQuery } from '../../../agent/queries.ts'
import { QueryError } from '../../../lib/query/query-boundary.tsx'
import { setupCatalogQuery } from '../../../setup/queries.ts'
import { SetupPicker } from '../../setup-picker.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'

/** A Persona's name as `@name` takes it: a letter, then up to 31 letters, digits, spaces, `_` or `-`. */
export const NAME = /^[A-Za-z][\w -]{0,31}$/u

/** A new Persona's definition before the owner writes one. */
export const BLANK: PersonaDefinition = {
  name: '',
  avatar: { glyph: '', hue: 140 },
  role: '',
  instructions: '',
  setup: NOTHING,
}

/**
 * The models a Persona can be given, from the Query cache. A list that could not be read says why instead of reading
 * as empty.
 */
function useModels() {
  const models = useQuery(modelQuery)
  return {
    models: models.data?.options ?? [],
    failure: models.error === null ? undefined : { error: models.error, retry: () => void models.refetch() },
  }
}

/** A list the form could not read, and a way to read it again. */
type ReadFailure = { readonly error: unknown; readonly retry: () => void }

type Edit = { readonly draft: PersonaDefinition; readonly onChange: (draft: PersonaDefinition) => void }

/** Its mark beside its name, then the mark's glyph and colour. */
function Identity({ draft, onChange }: Edit) {
  const nameOk = draft.name === '' || NAME.test(draft.name)
  return (
    <>
      <div className="persona-identity">
        <PersonaAvatar avatar={{ glyph: draft.avatar.glyph || '?', hue: draft.avatar.hue }} size="lg" />
        <Field data-invalid={!nameOk || undefined}>
          <FieldLabel htmlFor="persona-name">Name</FieldLabel>
          <Input
            id="persona-name"
            value={draft.name}
            maxLength={32}
            autoComplete="off"
            aria-invalid={!nameOk || undefined}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
          {!nameOk && <FieldDescription>A letter first, then letters, digits, spaces, _ or -.</FieldDescription>}
        </Field>
      </div>
      <div className="persona-mark">
        <Field>
          <FieldLabel htmlFor="persona-glyph">Mark</FieldLabel>
          <Input
            id="persona-glyph"
            value={draft.avatar.glyph}
            maxLength={4}
            autoComplete="off"
            onChange={(event) => onChange({ ...draft, avatar: { ...draft.avatar, glyph: event.target.value } })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="persona-hue">Colour</FieldLabel>
          <input
            id="persona-hue"
            className="persona-hue"
            type="range"
            min={0}
            max={359}
            value={draft.avatar.hue}
            onChange={(event) => onChange({ ...draft, avatar: { ...draft.avatar, hue: Number(event.target.value) } })}
          />
        </Field>
      </div>
    </>
  )
}

/** Its role in a line, its instructions, and its model (the agent's own unless one is chosen). */
function Behaviour({
  draft,
  onChange,
  models,
  failure,
}: Edit & { readonly models: ModelChoice['options']; readonly failure: ReadFailure | undefined }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="persona-role">Role</FieldLabel>
        <Input
          id="persona-role"
          value={draft.role}
          maxLength={120}
          placeholder="e.g. Finds the weak spot in a plan"
          onChange={(event) => onChange({ ...draft, role: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="persona-instructions">Instructions</FieldLabel>
        <Textarea
          id="persona-instructions"
          value={draft.instructions}
          maxLength={8000}
          rows={8}
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="persona-model">Model</FieldLabel>
        <NativeSelect
          id="persona-model"
          value={draft.model ?? ''}
          onChange={(event) => {
            const { model: _cleared, ...rest } = draft
            onChange(event.target.value === '' ? rest : { ...rest, model: event.target.value })
          }}
        >
          <NativeSelectOption value="">Your agent's model</NativeSelectOption>
          {models.map((model) => (
            <NativeSelectOption key={model.id} value={model.id}>
              {model.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {failure !== undefined && <QueryError error={failure.error} action="load the models" onRetry={failure.retry} />}
      </Field>
    </>
  )
}

/**
 * What a Persona adds to the setup of the Topic it answers in (ADR 0040): MCP servers and their tools, skills and apps,
 * each nothing by default, everything, or only the items chosen. It works with the Topic's setup and these together;
 * it never starts subagents. The catalog is read with the page.
 */
function Adds({ draft, onChange }: Edit) {
  const catalog = useQuery(setupCatalogQuery)
  return (
    <fieldset className="persona-adds">
      <legend>MCP servers & skills</legend>
      <p className="list-row-meta">
        It works with the setup of the Topic it answers in, and adds these. Only what you have granted or turned on.
      </p>
      {catalog.error !== null && (
        <QueryError error={catalog.error} action="load what can be chosen" onRetry={() => void catalog.refetch()} />
      )}
      {catalog.data !== undefined && (
        <SetupPicker setup={draft.setup} catalog={catalog.data} onChange={(setup) => onChange({ ...draft, setup })} />
      )}
    </fieldset>
  )
}

/**
 * A Persona's definition: its mark (a glyph on a hue), name, role, instructions, model, and what it adds to a Topic's
 * setup (ADR 0040). A Persona never starts subagents, so it never delegates or loops (ADR 0033).
 */
export function PersonaForm({ draft, onChange }: Edit) {
  const { models, failure } = useModels()
  return (
    <FieldGroup>
      <Identity draft={draft} onChange={onChange} />
      <Behaviour draft={draft} onChange={onChange} models={models} failure={failure} />
      <Adds draft={draft} onChange={onChange} />
    </FieldGroup>
  )
}
