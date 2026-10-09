import { useQuery } from '@tanstack/react-query'
import type { HelperExclusion, ModelChoice, PersonaDefinition } from '@goblin/contracts'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from '@goblin/ui'
import { modelQuery } from '../../../agent/queries.ts'
import { serversQuery } from '../../../mcp/queries.ts'
import { QueryError } from '../../../lib/query/query-boundary.tsx'
import { serverTitle } from '../../../lib/labels.ts'
import { PersonaAvatar } from '../../persona-avatar.tsx'

/** A Persona's name as `@name` takes it: a letter, then up to 31 letters, digits, spaces, `_` or `-`. */
export const NAME = /^[A-Za-z][\w -]{0,31}$/u

/** A new Persona's definition before the owner writes one. */
export const BLANK: PersonaDefinition = {
  name: '',
  avatar: { glyph: '', hue: 140 },
  role: '',
  instructions: '',
  exclusions: [],
}

/**
 * The models and connected servers a Persona can be given or kept from, from the Query cache. A list that could
 * not be read says why instead of reading as empty, so "No connections yet" is never shown for a failed read.
 */
function useChoices() {
  const models = useQuery(modelQuery)
  const servers = useQuery(serversQuery)
  return {
    models: models.data?.options ?? [],
    servers: (servers.data ?? []).filter((server) => server.status === 'connected'),
    failures: {
      models: models.error === null ? undefined : { error: models.error, retry: () => void models.refetch() },
      servers: servers.error === null ? undefined : { error: servers.error, retry: () => void servers.refetch() },
    },
  }
}

/** A list the form could not read, and a way to read it again. */
type ReadFailure = { readonly error: unknown; readonly retry: () => void }

const keyOf = (exclusion: HelperExclusion) => (exclusion.kind === 'server' ? `server:${exclusion.serverId}` : undefined)

/** Whether the Persona may use something: on unless its exclusions keep it from it; a switch toggles that. */
function Allowed({
  label,
  exclusion,
  draft,
  onChange,
}: {
  readonly label: string
  readonly exclusion: HelperExclusion
  readonly draft: PersonaDefinition
  readonly onChange: (draft: PersonaDefinition) => void
}) {
  const key = keyOf(exclusion)
  const off = draft.exclusions.some((each) => keyOf(each) === key)
  return (
    <label className="persona-allow">
      <span>{label}</span>
      <Switch
        checked={!off}
        onCheckedChange={(on) =>
          onChange({
            ...draft,
            exclusions: on ? draft.exclusions.filter((each) => keyOf(each) !== key) : [...draft.exclusions, exclusion],
          })
        }
      />
    </label>
  )
}

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
 * A Persona's definition: its mark (a glyph on a hue), name, role, instructions, model, and which of the owner's
 * connections it may use (it only ever narrows the owner's grants). A Persona never starts subagents, so it never
 * delegates or loops (ADR 0033); tool, skills and app exclusions it already has are kept as they are.
 */
export function PersonaForm({ draft, onChange }: Edit) {
  const { models, servers, failures } = useChoices()
  return (
    <FieldGroup>
      <Identity draft={draft} onChange={onChange} />
      <Behaviour draft={draft} onChange={onChange} models={models} failure={failures.models} />
      <fieldset className="persona-allows">
        <legend>May use</legend>
        {failures.servers !== undefined ? (
          <QueryError error={failures.servers.error} action="load your connections" onRetry={failures.servers.retry} />
        ) : (
          servers.length === 0 && <p className="list-row-meta">No connections yet.</p>
        )}
        {servers.map((server) => (
          <Allowed
            key={server.serverId}
            label={serverTitle(server)}
            exclusion={{ kind: 'server', serverId: server.serverId }}
            draft={draft}
            onChange={onChange}
          />
        ))}
      </fieldset>
    </FieldGroup>
  )
}
