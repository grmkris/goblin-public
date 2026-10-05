import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { InboundClient, MemoryStatus, ResidentStatus } from '@purrable/contracts'
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
  Count,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Meter,
} from '@purrable/ui'
import { ApiFailure, failureText, request } from '../lib/boundary.ts'
import { budgetFraction } from '../lib/usage.ts'
import { BillingCard } from './billing.tsx'
import { useBilling } from '../lib/billing.tsx'
import { PasskeysCard } from './passkeys.tsx'
import { useUsageToday } from './use-usage.ts'

const decodeResident = Schema.decodeUnknownSync(ResidentStatus)
const decodeClients = Schema.decodeUnknownSync(Schema.Array(InboundClient))
const decodeMemory = Schema.decodeUnknownSync(MemoryStatus)
const day = (seconds: number | undefined): string =>
  seconds === undefined ? '—' : new Date(seconds * 1000).toLocaleDateString()

/** Today's model budget: tokens spent against the daily limit, rolling as they change. */
function UsageCard() {
  const usage = useUsageToday()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model budget</CardTitle>
        <CardDescription>Tokens your agent used today (UTC). It resets at 00:00 UTC.</CardDescription>
      </CardHeader>
      <CardContent>
        {usage === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <Meter value={budgetFraction(usage) * 100} aria-label="Model budget used today">
            <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
              <Count value={usage.used} size="display" />
              <span>
                of <Count value={usage.limit} /> tokens
              </span>
              <Count value={budgetFraction(usage)} percent className="ml-auto" />
            </p>
          </Meter>
        )}
      </CardContent>
    </Card>
  )
}

/** Main's memory: what the agent remembers of the main conversation, and how much of it it reads as summaries. */
function MemoryCard({ onError }: { readonly onError: (message: string) => void }) {
  const [status, setStatus] = useState<MemoryStatus>()
  useEffect(() => {
    void request('/api/agent/memory')
      .then((data) => setStatus(decodeMemory(data)))
      .catch((failure: unknown) => onError(failureText(failure)))
  }, [onError])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          Your agent remembers the main conversation in full. It reads older messages as one-line summaries it can open
          again, so the conversation never has to end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
            <Count value={status.messages} size="display" />
            <span>
              messages remembered, <Count value={status.summarized} /> of them as summaries
            </span>
          </p>
        )}
      </CardContent>
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
  const billing = useBilling()
  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <BillingCard />
      {billing.state?.active && (
        <>
          <ResidentCard onError={setError} />
          <UsageCard />
          <MemoryCard onError={setError} />
        </>
      )}
      <PasskeysCard onError={setError} />
      {billing.state?.active && <ClientsCard onError={setError} />}
      <DeleteAccountCard onError={setError} />
    </div>
  )
}
