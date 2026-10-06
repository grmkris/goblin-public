import { useCallback, useEffect, useId, useState } from 'react'
import { Schema } from 'effect'
import { InboundClient, MemoryStatus, ResidentStatus } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardAction,
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
  Skeleton,
  Switch,
} from '@purrable/ui'
import { ApiFailure, failureText, request } from '../lib/boundary.ts'
import { residentStatus } from '../lib/labels.ts'
import { budgetFraction } from '../lib/usage.ts'
import { BillingCard } from './billing.tsx'
import { useBilling } from '../lib/billing.tsx'
import { PageSection } from './page-section.tsx'
import { PasskeysCard } from './passkeys.tsx'
import { RoutinesSection } from './routines.tsx'
import { StatusLabel } from './status-label.tsx'
import { useUsageToday } from './use-usage.ts'

const decodeResident = Schema.decodeUnknownSync(ResidentStatus)
const decodeClients = Schema.decodeUnknownSync(Schema.Array(InboundClient))
const decodeMemory = Schema.decodeUnknownSync(MemoryStatus)
const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

/** Today's model budget: tokens spent against the daily limit, rolling as they change. */
function UsageCard() {
  const usage = useUsageToday()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's usage</CardTitle>
        <CardDescription>Tokens your agent used today. It starts again at 00:00 UTC.</CardDescription>
      </CardHeader>
      <CardContent>
        {usage === undefined ? (
          <Skeleton className="h-10 w-full" />
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
          Your agent remembers Main in full. It reads older messages as one-line summaries it can open again, so the
          conversation never has to end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status === undefined ? (
          <Skeleton className="h-8 w-64" />
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

/**
 * Resident authority, as the owner meets it: whether the agent may use the tools they allowed while they are away. It
 * lasts 30 days from their last visit; turning it off stops all outbound use until they turn it on again.
 */
function ResidentCard({ onError }: { readonly onError: (message: string) => void }) {
  const id = useId()
  const [status, setStatus] = useState<ResidentStatus>()
  const [pending, setPending] = useState(false)
  useEffect(() => {
    void request('/api/agent/resident')
      .then((data) => setStatus(decodeResident(data)))
      .catch((error: unknown) => onError(failureText(error)))
  }, [onError])
  async function set(enabled: boolean): Promise<void> {
    setPending(true)
    try {
      setStatus(decodeResident(await request('/api/agent/resident', { body: { enabled } })))
    } catch (error) {
      onError(failureText(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle id={id}>Work while you're away</CardTitle>
        <CardDescription>
          Lets your agent use the tools you allowed when you are not watching: for apps you connected, routines and
          Telegram. It lasts 30 days from your last visit and renews whenever you use Purrable.
        </CardDescription>
        <CardAction>
          {status === undefined ? (
            <Skeleton className="h-5 w-9" />
          ) : (
            <Switch
              checked={status.state === 'active'}
              disabled={pending}
              aria-busy={pending}
              aria-labelledby={id}
              onCheckedChange={(checked) => void set(checked)}
            />
          )}
        </CardAction>
      </CardHeader>
      {status !== undefined && (
        <CardContent>
          <div className="card-line">
            <StatusLabel label={residentStatus(status.state)} />
            {status.state === 'active' && status.expiresAt !== undefined && (
              <span className="card-line-meta">until {day(status.expiresAt)}</span>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

/** The MCP clients the owner let use their agent, each revocable. */
function ClientsCard({ onError }: { readonly onError: (message: string) => void }) {
  const [clients, setClients] = useState<readonly InboundClient[]>()
  const [revoking, setRevoking] = useState('')
  const load = useCallback(() => {
    void request('/api/clients')
      .then((data) => setClients(decodeClients(data)))
      .catch((error: unknown) => onError(failureText(error)))
  }, [onError])
  useEffect(load, [load])
  async function revoke(clientId: string): Promise<void> {
    setRevoking(clientId)
    try {
      await request(`/api/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
      load()
    } catch (error) {
      onError(failureText(error))
    } finally {
      setRevoking('')
    }
  }
  return (
    <Card>
      <CardContent>
        {clients === undefined && <Skeleton className="h-6 w-full" />}
        {clients?.length === 0 && <p className="server-note">None yet.</p>}
        {clients !== undefined && clients.length > 0 && (
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
                  onClick={() => void revoke(client.clientId)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
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
          Deletes your account and personal agent, with its conversations, connections, permissions and usage. Cancel
          your subscription first. This cannot be undone.
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

/**
 * The owner's settings, most used first: their plan and today's usage, their agent, routines, how they sign in, the
 * apps that use their agent, and last the account itself. A lapsed plan shows only what still applies.
 */
export function Settings() {
  const [error, setError] = useState('')
  const active = useBilling().state?.active === true
  return (
    <div className="page-stack">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <PageSection id="plan" title="Plan and usage">
        <BillingCard />
        {active && <UsageCard />}
      </PageSection>
      {active && (
        <PageSection id="agent" title="Your agent">
          <ResidentCard onError={setError} />
          <MemoryCard onError={setError} />
        </PageSection>
      )}
      {active && <RoutinesSection />}
      <PageSection id="sign-in" title="Signing in">
        <PasskeysCard onError={setError} />
      </PageSection>
      {active && (
        <PageSection
          id="clients"
          title="Apps that use your agent"
          note={
            <>
              MCP clients you allowed to use Purrable at <code>{`${window.location.origin}/mcp`}</code>.
            </>
          }
        >
          <ClientsCard onError={setError} />
        </PageSection>
      )}
      <PageSection id="account" title="Account">
        <DeleteAccountCard onError={setError} />
      </PageSection>
    </div>
  )
}
