import { type ReactNode, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type QueryClient, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { type PersonaDefinition, type PersonaDetail, type PersonaView, type UpdatePersona } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { messageOf } from '../../../lib/query/app-error.ts'
import { QueryBoundary } from '../../../lib/query/query-boundary.tsx'
import { withRef } from '../../../lib/refusal.ts'
import { relativeTime } from '../../../lib/threads.ts'
import { reportUnexpected } from '../../../lib/unexpected.ts'
import { applyWorkspaceChanges } from '../../../lib/workspace/sync.ts'
import { createPersonaMutation, personaDetailQuery, updatePersonaMutation } from '../../../personas/queries.ts'
import { PageSection } from '../../page-section.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import { useMinute } from '../../use-now.ts'
import { BLANK, NAME, PersonaForm } from './persona-form.tsx'

/** What the owner reads when a Persona could not be saved: a conflict in its own words, anything else as described. */
function refusal(failure: Error | null, action: string): string {
  if (failure === null) return ''
  if (failure instanceof Conflict && failure.reason === 'persona_name_taken')
    return withRef('Another persona already has that name.', failure)
  if (failure instanceof Conflict)
    return withRef('It changed since you opened it. Reload to see the newest version.', failure)
  return messageOf(failure, action)
}

const definitionOf = ({
  name,
  avatar,
  role,
  instructions,
  model,
  exclusions,
}: PersonaDefinition): PersonaDefinition => ({
  name,
  avatar,
  role,
  instructions,
  exclusions,
  ...(model !== undefined && { model }),
})

const ready = (draft: PersonaDefinition) => NAME.test(draft.name) && draft.avatar.glyph.trim() !== ''

/** The definition's editor, what went wrong saving it, and its actions. */
function Editor({
  draft,
  onChange,
  error,
  children,
}: {
  readonly draft: PersonaDefinition
  readonly onChange: (draft: PersonaDefinition) => void
  readonly error: string
  readonly children: ReactNode
}) {
  return (
    <>
      <PersonaForm draft={draft} onChange={onChange} />
      {error !== '' && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="card-actions">{children}</div>
    </>
  )
}

/** A Persona's revisions, newest first: what it was called then, who changed it and when. */
function Revisions({ detail }: { readonly detail: PersonaDetail }) {
  const now = useMinute()
  return (
    <PageSection id="revisions" title="Revisions" count={detail.revisions.length}>
      <ol className="list-rows">
        {detail.revisions.map((revision) => (
          <li key={revision.revision} className="list-row" data-static>
            <span className="list-row-mark">
              <PersonaAvatar avatar={revision.avatar} size="sm" />
            </span>
            <span className="list-row-main">
              <span className="list-row-title">
                {revision.revision}. {revision.name}
                {revision.role === '' ? '' : ` · ${revision.role}`}
              </span>
              <span className="list-row-meta">
                {revision.actor === 'agent' ? 'Goblin' : 'You'} · {relativeTime(revision.createdAt, now)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </PageSection>
  )
}

/**
 * The definition being edited: what the owner typed, and the revision it started from, which a save names
 * (`expectedRevision`), so a revision someone else saved meanwhile is a conflict, never overwritten. A save starts the
 * draft again from what was saved.
 */
function useDraft(persona: PersonaView) {
  const [draft, setDraft] = useState<PersonaDefinition>(() => definitionOf(persona))
  const [base, setBase] = useState(persona.revision)
  const saved = (next: PersonaView) => {
    setDraft(definitionOf(next))
    setBase(next.revision)
  }
  return { draft, setDraft, base, saved }
}

/** Saving a new revision of `persona`: the feed shows it at once, and the profile reads it again. */
function useSave(queryClient: QueryClient, persona: PersonaView, saved: (next: PersonaView) => void) {
  const save = useMutation(updatePersonaMutation(persona.id))
  const start = (change: UpdatePersona) =>
    save.mutate(change, {
      onSuccess: (next) => {
        applyWorkspaceChanges(queryClient, [{ type: 'persona', persona: next }])
        saved(next)
      },
    })
  return { start, pending: save.isPending, error: refusal(save.error, 'save the persona') }
}

/** A Persona's profile (`/p/<id>`): its definition to edit, Save as a new revision, Archive or Restore, its revisions. */
function Profile({ id }: { readonly id: number }) {
  const queryClient = useQueryClient()
  const detail = useSuspenseQuery(personaDetailQuery(id)).data
  const { draft, setDraft, base, saved } = useDraft(detail.persona)
  const save = useSave(queryClient, detail.persona, saved)
  const archived = detail.persona.archivedAt !== undefined
  return (
    <div className="page-stack">
      <PageSection id="definition" title={archived ? `${detail.persona.name} (archived)` : detail.persona.name}>
        <Editor draft={draft} onChange={setDraft} error={save.error}>
          <Button
            pending={save.pending}
            disabled={!ready(draft)}
            onClick={() => save.start({ ...draft, model: draft.model ?? null, expectedRevision: base })}
          >
            Save
          </Button>
          <Button
            variant="outline"
            disabled={save.pending}
            onClick={() => save.start({ archived: !archived, expectedRevision: base })}
          >
            {archived ? 'Restore' : 'Archive'}
          </Button>
        </Editor>
      </PageSection>
      <Revisions detail={detail} />
    </div>
  )
}

/** A new Persona (`/p/new`): its definition, then Create, which opens its profile. One operation id per visit. */
function Create() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<PersonaDefinition>(BLANK)
  const [operation] = useState(() => crypto.randomUUID())
  const create = useMutation(createPersonaMutation)
  const submit = () =>
    create.mutate(
      { ...draft, operationId: operation },
      {
        onSuccess: (persona) => {
          applyWorkspaceChanges(queryClient, [{ type: 'persona', persona }])
          navigate({ to: '/p/$id', params: { id: String(persona.id) }, replace: true }).catch(reportUnexpected)
        },
      },
    )
  return (
    <div className="page-stack">
      <PageSection id="definition" title="New persona">
        <Editor draft={draft} onChange={setDraft} error={refusal(create.error, 'create the persona')}>
          <Button pending={create.isPending} disabled={!ready(draft)} onClick={submit}>
            Create
          </Button>
        </Editor>
      </PageSection>
    </div>
  )
}

/**
 * `/p/<id>` or `/p/new`: a Persona's profile, or a new one. The profile waits for its Persona; a read that fails stays
 * in place with the reference to quote and a retry.
 */
export function PersonaPage({ id }: { readonly id: number | 'new' }) {
  if (id === 'new') return <Create />
  return (
    <QueryBoundary key={id} action="load the persona" pending={<Skeleton className="h-64 w-full" />}>
      <Profile id={id} />
    </QueryBoundary>
  )
}
