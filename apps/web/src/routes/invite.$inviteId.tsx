import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Schema } from 'effect'
import { InvitationPreview, WorkspaceState } from '@purrable/contracts'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { authClient } from '../lib/auth-client.ts'
import { failureText, request } from '../lib/boundary.ts'
import { useSession } from '../lib/session.tsx'
import { useBilling } from '../lib/billing.tsx'

export const Route = createFileRoute('/invite/$inviteId')({
  component: InvitationPage,
  head: () => ({ meta: [{ name: 'referrer', content: 'no-referrer' }] }),
})
const preview = Schema.decodeUnknownSync(Schema.NullOr(InvitationPreview))
const Accepted = Schema.Struct({ accepted: Schema.Boolean, memberId: Schema.String })
const write = (path: string, body: unknown) => request(path, { body, headers: { 'x-purrable-csrf': '1' } })

function useInvitation(inviteId: string) {
  const [invitation, setInvitation] = useState<InvitationPreview | null>()
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const fragment = window.location.hash.slice(1)
    // Remove the proof before any request; keep it out of history, referrers, query strings and device storage.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    const lookup = fragment
      ? write(`/api/invitations/${inviteId}/preview`, { proof: fragment })
      : request('/api/invitations/admission')
    void lookup
      .then((data) => {
        const value = preview(data)
        setInvitation(value?.id === inviteId ? value : null)
      })
      .catch((cause: unknown) => {
        setError(failureText(cause))
        setInvitation(null)
      })
  }, [inviteId])
  async function exchange() {
    setPending(true)
    setError('')
    try {
      setInvitation(preview(await write(`/api/invitations/${inviteId}/preview`, { proof: code.trim().toUpperCase() })))
      setCode('')
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  async function join() {
    setPending(true)
    setError('')
    try {
      const receipt = Schema.decodeUnknownSync(Accepted)(await write(`/api/invitations/${inviteId}/accept`, {}))
      const workspaces = Schema.decodeUnknownSync(WorkspaceState)(await request('/api/workspaces'))
      const joined = workspaces.workspaces.find((workspace) => workspace.memberId === receipt.memberId)
      if (joined === undefined) throw new Error('Membership was saved but is no longer active. Open Settings.')
      await write('/api/workspaces/active', { workspaceId: joined.id, context: workspaces.context })
      window.location.assign('/settings')
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return { invitation, error, code, setCode, pending, exchange, join }
}

function InvitationPage() {
  const { inviteId } = Route.useParams()
  const state = useInvitation(inviteId)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.invitation ? `Join ${state.invitation.workspaceName}` : 'Purrable invitation'}</CardTitle>
        <CardDescription>
          {state.invitation
            ? `Invited by ${state.invitation.ownerName} as a ${state.invitation.role}.`
            : 'Open the emailed link or enter its invitation code.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {state.error && <p role="alert">{state.error}</p>}
          <InvitationBody state={state} />
        </div>
      </CardContent>
    </Card>
  )
}
function InvitationBody({ state }: { readonly state: ReturnType<typeof useInvitation> }) {
  if (state.invitation === undefined) return <p role="status">Checking invitation…</p>
  if (state.invitation === null)
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void state.exchange()
        }}
      >
        <Field>
          <FieldLabel htmlFor="invitation-code">Invitation code</FieldLabel>
          <Input
            id="invitation-code"
            value={state.code}
            autoComplete="off"
            onChange={(event) => state.setCode(event.target.value)}
            required
          />
        </Field>
        <Button disabled={state.pending} type="submit">
          Check invitation
        </Button>
      </form>
    )
  return <InviteAcceptance invitation={state.invitation} pending={state.pending} join={state.join} />
}
function InviteAcceptance({
  invitation,
  pending,
  join,
}: {
  readonly invitation: InvitationPreview
  readonly pending: boolean
  readonly join: () => Promise<void>
}) {
  const [session] = useSession()
  const billing = useBilling()
  return (
    <>
      <p>
        This invitation is for {invitation.email}. The workspace owner can read every conversation. You need your own
        Pro subscription and your usage will count against your own allowance.
      </p>
      <InviteSignIn email={invitation.email} />
      {session === 'signed-in' &&
        (billing.state?.active ? (
          <Button disabled={pending} onClick={() => void join()}>
            {pending ? 'Joining…' : 'Accept invitation'}
          </Button>
        ) : (
          <>
            <p>You need Pro before joining.</p>
            <a href="/subscribe" className="underline">
              Subscribe to Pro ($10/month)
            </a>
          </>
        ))}
    </>
  )
}

/** Only the addressed email can use this admission. Six-digit sign-in OTP is distinct from the invitation code. */
function InviteSignIn({ email }: { readonly email: string }) {
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function send() {
    setPending(true)
    setError('')
    const result = await authClient.emailOtp
      .sendVerificationOtp({ email, type: 'sign-in' })
      .catch(() => ({ error: true }))
    if (result.error) setError('Could not send a sign-in code. Reopen the invitation if it expired.')
    else setSent(true)
    setPending(false)
  }
  async function verify() {
    setPending(true)
    setError('')
    const result = await authClient.signIn.emailOtp({ email, otp: code }).catch(() => ({ error: true }))
    if (result.error) {
      setError('That sign-in code did not work. Check it or reopen the invitation.')
      setPending(false)
    } else window.location.reload()
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">Sign in with a fresh email code to accept, even if you already have an account.</p>
      {error && <p role="alert">{error}</p>}
      {sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void verify()
          }}
        >
          <Field>
            <FieldLabel htmlFor="member-signin-code">Six-digit sign-in code</FieldLabel>
            <Input
              id="member-signin-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={pending}>
            Sign in as {email}
          </Button>
        </form>
      ) : (
        <Button variant="outline" disabled={pending} onClick={() => void send()}>
          Email a sign-in code to {email}
        </Button>
      )}
    </div>
  )
}
