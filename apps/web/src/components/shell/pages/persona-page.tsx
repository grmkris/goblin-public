import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PersonaDetail, type PersonaDefinition, PersonaView } from '@goblin/contracts'
import { Schema } from 'effect'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { ApiFailure, failureText, request } from '../../../lib/boundary.ts'
import { relativeTime } from '../../../lib/threads.ts'
import { PageSection } from '../../page-section.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import { useMinute } from '../../use-now.ts'
import { useWorkspaceFeed } from '../../workspace-feed.tsx'
import { BLANK, NAME, PersonaForm } from './persona-form.tsx'

const decodeDetail = Schema.decodeUnknownSync(PersonaDetail)
const decodePersona = Schema.decodeUnknownSync(PersonaView)

/** What the owner reads when a Persona could not be saved. */
function refusal(failure: unknown): string {
  if (failure instanceof ApiFailure && failure.status === 409)
    return 'It changed since you opened it. Reload to see the newest version.'
  if (failure instanceof ApiFailure && failure.status === 404) return 'Personas are not on this server yet.'
  return failureText(failure)
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

/** A Persona's profile (`/p/<id>`): its definition to edit, Save as a new revision, Archive or Restore, its revisions. */
function Profile({ id }: { readonly id: number }) {
  const feed = useWorkspaceFeed()
  const [detail, setDetail] = useState<PersonaDetail>()
  const [draft, setDraft] = useState<PersonaDefinition>(BLANK)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    request(`/api/personas/${id}`, { signal: controller.signal })
      .then((data) => {
        const loaded = decodeDetail(data)
        setDetail(loaded)
        setDraft(definitionOf(loaded.persona))
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(refusal(failure))
      })
    return () => controller.abort()
  }, [id])
  async function save(change: Record<string, unknown>): Promise<void> {
    if (detail === undefined) return
    setPending(true)
    setError('')
    try {
      const body = { ...change, expectedRevision: detail.persona.revision }
      const persona = decodePersona(await request(`/api/personas/${id}`, { method: 'PATCH', body }))
      feed.apply([{ type: 'persona', persona }])
      setDetail(decodeDetail(await request(`/api/personas/${id}`)))
    } catch (failure) {
      setError(refusal(failure))
    } finally {
      setPending(false)
    }
  }
  if (detail === undefined)
    return error === '' ? <Skeleton className="h-64 w-full" /> : <p className="page-empty">{error}</p>
  const archived = detail.persona.archivedAt !== undefined
  return (
    <div className="page-stack">
      <PageSection id="definition" title={archived ? `${detail.persona.name} (archived)` : detail.persona.name}>
        <Editor draft={draft} onChange={setDraft} error={error}>
          <Button
            pending={pending}
            disabled={!ready(draft)}
            onClick={() => void save({ ...draft, model: draft.model ?? null })}
          >
            Save
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => void save({ archived: !archived })}>
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
  const feed = useWorkspaceFeed()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<PersonaDefinition>(BLANK)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- One idempotency key per visit, so a retry finds the same Persona.
  const [operation] = useState(() => crypto.randomUUID())
  async function create(): Promise<void> {
    setPending(true)
    setError('')
    try {
      const body = { ...draft, operationId: operation }
      const persona = decodePersona(await request('/api/personas', { body }))
      feed.apply([{ type: 'persona', persona }])
      void navigate({ to: '/p/$id', params: { id: String(persona.id) }, replace: true })
    } catch (failure) {
      setError(refusal(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="page-stack">
      <PageSection id="definition" title="New persona">
        <Editor draft={draft} onChange={setDraft} error={error}>
          <Button pending={pending} disabled={!ready(draft)} onClick={() => void create()}>
            Create
          </Button>
        </Editor>
      </PageSection>
    </div>
  )
}

/** `/p/<id>` or `/p/new`: a Persona's profile, or a new one. */
export function PersonaPage({ id }: { readonly id: number | 'new' }) {
  return id === 'new' ? <Create /> : <Profile key={id} id={id} />
}
