// A connection's own forms (ADR 0041): a new label for it, another connection to the same server under a label of its
// own, and the access it signs in with (ADR 0042), inline in its card like Remove's confirmation.
import { type SubmitEvent, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import {
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Receipt,
  Switch,
} from '@goblin/ui'
import { CircleAlertIcon } from 'lucide-react'
import { useAddAndConnect } from '../mcp/hooks.ts'
import { accessQuery, connectMutation, renameConnectionMutation } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { serverName } from '../lib/labels.ts'

/** A label is one line of at most eighty characters, as the runtime takes it. */
const MAX_LABEL = 80
const tidy = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim()

/** What a refused label says: the owner can act on it. */
const TAKEN = 'Another connection already has that name; choose another.'
const taken = (error: unknown): boolean => error instanceof Conflict && error.reason === 'label_taken'

/** One label field with its action and Cancel, inline in a card. */
function LabelForm({
  title,
  hint,
  initial,
  action,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly title: string
  readonly hint: string
  readonly initial: string
  readonly action: string
  readonly pending: boolean
  readonly onSubmit: (label: string) => void
  readonly onCancel: () => void
}) {
  const id = useId()
  const [label, setLabel] = useState(initial)
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (tidy(label) !== '') onSubmit(tidy(label))
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{title}</FieldLabel>
          <Input
            id={id}
            value={label}
            maxLength={MAX_LABEL}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
            required
          />
          <FieldDescription>{hint}</FieldDescription>
        </Field>
        <div className="inline-confirm">
          <Button type="submit" size="sm" pending={pending} disabled={tidy(label) === ''}>
            {action}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

/** A connection's new label: what the owner, the agent and every card call it from now on. */
export function RenameConnection({
  server,
  onDone,
  onMessage,
}: {
  readonly server: ServerView
  readonly onDone: () => void
  readonly onMessage: (message: string) => void
}) {
  const renaming = useMutation(renameConnectionMutation)
  return (
    <LabelForm
      title="Name"
      hint="What you and your agent call this connection, e.g. Sidequest · Hirer."
      initial={server.label}
      action="Save"
      pending={renaming.isPending}
      onCancel={onDone}
      onSubmit={(label) =>
        renaming.mutate(
          { connectionId: server.connectionId, label },
          {
            onSuccess: onDone,
            onError: (error) => onMessage(taken(error) ? TAKEN : messageOf(error, `rename ${server.label}`)),
          },
        )
      }
    />
  )
}

/**
 * Another connection to the same server, as another account: named first, then signed in. The provider's consent
 * screen shows the name, so the owner can check they are signing in as the account they mean.
 */
export function AnotherConnection({
  server,
  onDone,
  onMessage,
}: {
  readonly server: ServerView
  readonly onDone: (message: string) => void
  readonly onMessage: (message: string) => void
}) {
  const addAndConnect = useAddAndConnect()
  const [pending, setPending] = useState(false)
  const base = serverName(server) ?? server.label
  const add = async (label: string) => {
    setPending(true)
    try {
      onDone(await addAndConnect(server.endpoint, label, { label }))
    } catch (error) {
      onMessage(taken(error) ? TAKEN : messageOf(error, `add another connection to ${base}`))
    } finally {
      setPending(false)
    }
  }
  return (
    <LabelForm
      title="Name the new connection"
      hint={`Another account on ${base}. You sign in to it next; pick the account you mean there.`}
      initial={`${base} 2`}
      action="Add and sign in"
      pending={pending}
      onCancel={() => onDone('')}
      onSubmit={(label) => void add(label)}
    />
  )
}

/** The scopes a sign-in starts from: what the connection holds when that is known, else everything offered. */
export const startingScopes = (offered: readonly string[], held: readonly string[] | null): readonly string[] => {
  const shown = offered.filter((scope) => scope !== 'offline_access')
  const kept = held?.filter((scope) => shown.includes(scope))
  return kept === undefined || kept.length === 0 ? shown : kept
}

/** One scope's switch: on, it is asked for at sign-in. */
function ScopeSwitch({
  scope,
  on,
  onChange,
}: {
  readonly scope: string
  readonly on: boolean
  readonly onChange: (on: boolean) => void
}) {
  const id = useId()
  return (
    <Field orientation="horizontal">
      <Switch id={id} checked={on} onCheckedChange={onChange} />
      <FieldLabel htmlFor={id}>
        <span className="scope-name">{scope}</span>
      </FieldLabel>
    </Field>
  )
}

/**
 * Which of what the server offers this connection signs in with (ADR 0042): what it holds now, or everything offered,
 * with the owner leaving out what it should not have. A tool that needs more later asks for just that.
 */
export function ChooseAccess({
  server,
  onCancel,
  onMessage,
}: {
  readonly server: ServerView
  readonly onCancel: () => void
  readonly onMessage: (message: string) => void
}) {
  const access = useQuery(accessQuery(server.connectionId))
  const connect = useMutation(connectMutation)
  const [chosen, setChosen] = useState<ReadonlySet<string>>()
  if (access.error !== null)
    return (
      <Receipt tone="error">
        <CircleAlertIcon aria-hidden />
        <span>{messageOf(access.error, `read what ${server.label} offers`)}</span>
      </Receipt>
    )
  if (access.data === undefined) return <p className="server-note">Reading what {server.label} offers…</p>
  const offered = access.data.offered.filter((scope) => scope !== 'offline_access')
  const picked = chosen ?? new Set(startingScopes(access.data.offered, access.data.held))
  const leaving = connect.isSuccess && connect.data.authorizationUrl !== undefined
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    connect.mutate(
      { connectionId: server.connectionId, scope: offered.filter((scope) => picked.has(scope)) },
      {
        onSuccess: ({ authorizationUrl }) => {
          if (authorizationUrl === undefined) onCancel()
          else window.location.assign(authorizationUrl)
        },
        onError: (error) => onMessage(messageOf(error, `sign in to ${server.label}`)),
      },
    )
  }
  if (offered.length === 0)
    return (
      <div className="inline-confirm">
        <p className="server-note">{server.label} offers no access to choose from: it signs in with what it gives.</p>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    )
  return (
    <form onSubmit={submit}>
      <FieldSet>
        <FieldLegend variant="label">Access to sign in with</FieldLegend>
        <FieldDescription>
          Leave out what this connection should not have. If a tool needs more later, goblin asks you to sign in again
          for just that.
        </FieldDescription>
        <div className="scope-list">
          {offered.map((scope) => (
            <ScopeSwitch
              key={scope}
              scope={scope}
              on={picked.has(scope)}
              onChange={(on) => setChosen(new Set(on ? [...picked, scope] : [...picked].filter((s) => s !== scope)))}
            />
          ))}
        </div>
        <div className="inline-confirm">
          <Button type="submit" size="sm" pending={connect.isPending || leaving} disabled={picked.size === 0}>
            {server.status === 'connected' ? 'Sign in again' : 'Sign in'}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={connect.isPending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </FieldSet>
    </form>
  )
}
