import { type ReactNode, type SubmitEvent, useId, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
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
  FieldGroup,
  Meter,
  Skeleton,
  Switch,
} from '@goblin/ui'
import { AuthRefused, deleteAccountMutation } from '../auth/queries.ts'
import { residentStatus } from '../lib/labels.ts'
import { budgetFraction } from '../lib/usage.ts'
import { BillingCard } from './billing.tsx'
import { useBilling } from '../account/hooks.ts'
import { PageSection } from './page-section.tsx'
import { RoutinesSection } from './routines.tsx'
import { StatusLabel } from './status-label.tsx'
import { clientsQuery, revokeClientMutation } from '../account/queries.ts'
import { memoryQuery, residentQuery, setResidentMutation, usageQuery } from '../agent/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { QueryBoundary, QueryError } from '../lib/query/query-boundary.tsx'

const day = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

/**
 * Today's spend against the daily limit, rolling as it changes. It is read again whenever a run ends, since that is
 * when a turn's spend is recorded (`lib/workspace/invalidations.ts`); a failed re-read keeps the last value and says why.
 */
function UsageMeter() {
  const read = useSuspenseQuery(usageQuery)
  const usage = read.data
  return (
    <>
      {read.isRefetchError && (
        <QueryError error={read.error} action="read today's usage" onRetry={() => void read.refetch()} />
      )}
      <Meter value={budgetFraction(usage) * 100} aria-label="Model budget used today">
        <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
          <Count value={usage.used} size="display" />
          <span>
            of <Count value={usage.limit} /> Credits
          </span>
          <Count value={budgetFraction(usage)} percent className="ml-auto" />
        </p>
      </Meter>
    </>
  )
}

/** Today's model budget: Credits spent against the daily limit (ADR 0026). */
function UsageCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today's usage</CardTitle>
        <CardDescription>
          Model Credits your agent used today. Writing costs more than reading, and context the model has seen before
          costs much less. It starts again at 00:00 UTC.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <QueryBoundary action="read today's usage" pending={<Skeleton className="h-10 w-full" />}>
            <UsageMeter />
          </QueryBoundary>
        </div>
      </CardContent>
    </Card>
  )
}

function MemoryCount() {
  const status = useSuspenseQuery(memoryQuery()).data
  return (
    <p className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
      <Count value={status.messages} size="display" />
      <span>
        messages remembered, <Count value={status.summarized} /> of them as summaries
      </span>
    </p>
  )
}

/** Main's memory: what the agent remembers of the main conversation, and how much of it it reads as summaries. */
function MemoryCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          Your agent remembers #Personal in full. It reads older messages as one-line summaries it can open again, so
          the conversation never has to end.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="read what your agent remembers" pending={<Skeleton className="h-8 w-64" />}>
          <MemoryCount />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}

/** The resident card's heading, with `action` (the switch, or its placeholder while the status loads) beside it. */
function ResidentHeader({ id, action }: { readonly id: string; readonly action: ReactNode }) {
  return (
    <CardHeader>
      <CardTitle id={id}>Work while you're away</CardTitle>
      <CardDescription>
        Lets your agent use the tools you allowed when you are not watching: for apps you connected, routines and
        Telegram. It lasts 30 days from your last visit and renews whenever you use goblin.
      </CardDescription>
      <CardAction>{action}</CardAction>
    </CardHeader>
  )
}

function Resident({ id }: { readonly id: string }) {
  const status = useSuspenseQuery(residentQuery).data
  const change = useMutation(setResidentMutation)
  const pending = change.isPending
  const failure =
    change.error === null ? '' : messageOf(change.error, 'change whether your agent may work while you are away')
  return (
    <>
      <ResidentHeader
        id={id}
        action={
          <Switch
            checked={status.state === 'active'}
            disabled={pending}
            aria-busy={pending}
            aria-labelledby={id}
            onCheckedChange={(checked) => change.mutate(checked)}
          />
        }
      />
      {failure && (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        </CardContent>
      )}
      <CardContent>
        <div className="card-line">
          <StatusLabel label={residentStatus(status.state)} />
          {status.state === 'active' && status.expiresAt !== undefined && (
            <span className="card-line-meta">until {day(status.expiresAt)}</span>
          )}
        </div>
      </CardContent>
    </>
  )
}

/**
 * Resident authority, as the owner meets it: whether the agent may use the tools they allowed while they are away. It
 * lasts 30 days from their last visit; turning it off stops all outbound use until they turn it on again.
 */
function ResidentCard() {
  const id = useId()
  return (
    <Card>
      <QueryBoundary
        action="read whether your agent may work while you are away"
        pending={<ResidentHeader id={id} action={<Skeleton className="h-5 w-9" />} />}
      >
        <Resident id={id} />
      </QueryBoundary>
    </Card>
  )
}

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
function ClientsCard() {
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
function DeleteAccountCard() {
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

/**
 * The owner's settings, most used first: their plan and today's usage, their agent, routines, how they sign in, the
 * apps that use their agent, and last the account itself. A lapsed plan shows only what still applies.
 */
export function Settings() {
  const active = useBilling().state?.active === true
  return (
    <div className="page-stack">
      <PageSection id="plan" title="Plan and usage">
        <BillingCard />
        {active && <UsageCard />}
      </PageSection>
      {active && (
        <PageSection id="agent" title="Your agent">
          <ResidentCard />
          <MemoryCard />
        </PageSection>
      )}
      {active && <RoutinesSection />}
      {active && (
        <PageSection
          id="clients"
          title="Apps that use your agent"
          note={
            <>
              MCP clients you allowed to use goblin at <code>{`${window.location.origin}/mcp`}</code>.
            </>
          }
        >
          <ClientsCard />
        </PageSection>
      )}
      <PageSection id="account" title="Account">
        <DeleteAccountCard />
      </PageSection>
    </div>
  )
}
