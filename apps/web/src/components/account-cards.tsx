// The Settings cards about the account: the MCP clients that use the agent, and deleting the account.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  Skeleton,
} from '@goblin/ui'
import { clientsQuery, revokeClientMutation } from '../account/queries.ts'
import { AuthRefused, deleteAccountMutation } from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'

function Clients() {
  const clients = useSuspenseQuery(clientsQuery).data
  const revoke = useMutation(revokeClientMutation)
  const revoking = revoke.isPending ? revoke.variables : ''
  const failure = revoke.error === null ? '' : messageOf(revoke.error, 'revoke that app')
  return (
    <>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {clients.length === 0 && <p className="server-note">None yet.</p>}
      {clients.length > 0 && (
        <ul className="pick-list">
          {clients.map((client) => (
            <li className="pick-row" key={client.clientId}>
              <span className="grant-text">
                <span className="grant-name">{client.name ?? client.clientId}</span>
                {client.uri && <span className="grant-about">{client.uri}</span>}
              </span>
              <Button
                size="sm"
                variant="outline"
                pending={revoking === client.clientId}
                disabled={revoking !== '' && revoking !== client.clientId}
                onClick={() => revoke.mutate(client.clientId)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The MCP clients the owner let use their agent, each revocable. */
export function ClientsCard() {
  return (
    <Card>
      <CardContent>
        <QueryBoundary action="list the apps that use your agent" pending={<Skeleton className="h-6 w-full" />}>
          <Clients />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}

/** Permanent: the account, its agent's conversations, MCP connections and grants. A fresh code sign-in confirms it. */
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false)
  const deleting = useMutation(deleteAccountMutation)
  // A deleted account is leaving for the start page, so the button stays busy.
  const pending = deleting.isPending || deleting.isSuccess
  const failure =
    deleting.error === null
      ? ''
      : deleting.error instanceof AuthRefused && (deleting.error.status === 400 || deleting.error.status === 401)
        ? withRef('Sign in again with an emailed code, then delete within 10 minutes.', deleting.error)
        : messageOf(deleting.error, 'delete your account')
  function remove(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    deleting.mutate(undefined, { onSuccess: () => window.location.assign('/') })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Deletes your account and personal agent, with its conversations, connections, permissions and usage. Cancel
          your subscription first. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {open ? (
          <form onSubmit={remove}>
            <FieldGroup>
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
              <p className="text-sm text-muted-foreground">
                Sign in again with an emailed code first. Deleting works for 10 minutes after signing in.
              </p>
              <Field orientation="horizontal">
                <Button type="submit" variant="destructive" pending={pending}>
                  Delete my account
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Delete account…
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
