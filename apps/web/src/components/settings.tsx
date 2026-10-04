import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { InboundClient, ResidentStatus, UsageToday } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { ApiFailure, failureText, request } from '../lib/boundary.ts'

const decodeResident = Schema.decodeUnknownSync(ResidentStatus)
const decodeClients = Schema.decodeUnknownSync(Schema.Array(InboundClient))
const decodeUsage = Schema.decodeUnknownSync(UsageToday)
const day = (seconds: number | undefined): string =>
  seconds === undefined ? '—' : new Date(seconds * 1000).toLocaleDateString()

function UsageCard({ onError }: { readonly onError: (message: string) => void }) {
  const [usage, setUsage] = useState<UsageToday>()
  useEffect(() => {
    void request('/api/agent/usage')
      .then((data) => setUsage(decodeUsage(data)))
      .catch((error: unknown) => onError(failureText(error)))
  }, [onError])
  const percent = usage === undefined ? 0 : Math.min(100, Math.round((usage.used / usage.limit) * 100))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model budget</CardTitle>
        <CardDescription>
          {usage === undefined
            ? 'Loading…'
            : `${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} tokens used today (${percent}%). Resets at 00:00 UTC.`}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

function ResidentCard({ onError }: { readonly onError: (message: string) => void }) {
  const [status, setStatus] = useState<ResidentStatus>()
  useEffect(() => {
    void request('/api/agent/resident')
      .then((data) => setStatus(decodeResident(data)))
      .catch((error: unknown) => onError(failureText(error)))
  }, [onError])
  async function set(enabled: boolean): Promise<void> {
    try {
      setStatus(decodeResident(await request('/api/agent/resident', { body: { enabled } })))
    } catch (error) {
      onError(failureText(error))
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Resident authority</CardTitle>
        <CardDescription>
          Lets your agent use your enabled tools without you watching: answering connected MCP clients now, routines and
          channels later. It lasts 30 days from your last visit and renews whenever you use Purrable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={status?.state === 'active' ? 'secondary' : 'destructive'}>{status?.state ?? '…'}</Badge>
          <span className="text-muted-foreground text-sm">Until {day(status?.expiresAt)}</span>
          {status?.state === 'revoked' ? (
            <Button size="sm" onClick={() => void set(true)}>
              Re-enable
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void set(false)}>
              Revoke
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ClientsCard({ onError }: { readonly onError: (message: string) => void }) {
  const [clients, setClients] = useState<readonly InboundClient[]>([])
  const load = useCallback(() => {
    void request('/api/clients')
      .then((data) => setClients(decodeClients(data)))
      .catch((error: unknown) => onError(failureText(error)))
  }, [onError])
  useEffect(load, [load])
  async function revoke(clientId: string): Promise<void> {
    try {
      await request(`/api/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
      load()
    } catch (error) {
      onError(failureText(error))
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected MCP clients</CardTitle>
        <CardDescription>
          Apps you allowed to use Purrable at <code>{`${window.location.origin}/mcp`}</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {clients.length === 0 && <p className="text-muted-foreground text-sm">No clients yet.</p>}
          {clients.map((client) => (
            <div className="flex items-center justify-between gap-3" key={client.clientId}>
              <span>
                {client.name ?? client.clientId}
                {client.uri && <span className="text-muted-foreground text-sm"> · {client.uri}</span>}
              </span>
              <Button size="sm" variant="outline" onClick={() => void revoke(client.clientId)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** Permanent: the account, its agent's conversations, MCP connections and grants. The password confirms it. */
function DeleteAccountCard({ onError }: { readonly onError: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  async function remove(): Promise<void> {
    setPending(true)
    try {
      await request('/api/auth/delete-user', { body: password ? { password } : {} })
      window.location.assign('/')
    } catch (error) {
      // Better Auth answers a wrong password with 400 and its own code, not an AppError tag.
      onError(
        error instanceof ApiFailure && error.status === 400
          ? 'That password is not right, or your sign-in is older than 10 minutes. Sign in again, then retry.'
          : failureText(error),
      )
    } finally {
      setPassword('')
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Deletes your account and your agent: its conversations, MCP connections, permissions and usage. This cannot be
          undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {open ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void remove()
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="delete-password">Your password, if your account has one</FieldLabel>
                <Input
                  id="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <FieldDescription>
                  Without a password, sign in again with a code first: deleting works for 10 minutes after.
                </FieldDescription>
              </Field>
              <Field>
                <Button type="submit" variant="destructive" disabled={pending}>
                  {pending ? 'Deleting…' : 'Delete my account and agent'}
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

export function Settings() {
  const [error, setError] = useState('')
  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ResidentCard onError={setError} />
      <UsageCard onError={setError} />
      <ClientsCard onError={setError} />
      <DeleteAccountCard onError={setError} />
    </div>
  )
}
