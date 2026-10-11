// A connection's own forms (ADR 0041): a new label for it, and another connection to the same server under a label of
// its own, inline in its card like Remove's confirmation.
import { type SubmitEvent, useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ServerView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input } from '@goblin/ui'
import { useAddAndConnect } from '../mcp/hooks.ts'
import { renameConnectionMutation } from '../mcp/queries.ts'
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
