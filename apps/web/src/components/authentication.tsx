import { useEffect, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { ApiFailure, record, request } from '../lib/boundary.ts'

type SignupMode = 'open' | 'invite' | 'closed'

/** How this deployment admits new accounts, from the public health endpoint. Unknown means closed. */
function useSignupMode(): SignupMode {
  const [mode, setMode] = useState<SignupMode>('closed')
  useEffect(() => {
    const controller = new AbortController()
    void request('/health', { signal: controller.signal })
      .then((data) => {
        const signup = record(data)?.signup
        if (!controller.signal.aborted && (signup === 'open' || signup === 'invite')) setMode(signup)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  return mode
}

async function createAccount(email: string, password: string, inviteCode: string): Promise<void> {
  try {
    await request('/api/auth/sign-up/email', {
      body: { email, password, name: email.split('@')[0] ?? email },
      headers: inviteCode ? { 'x-invite-code': inviteCode } : {},
    })
  } catch (cause) {
    if (cause instanceof ApiFailure && cause.status === 403)
      throw new Error('Sign-up needs a valid invite code.', { cause })
    const status = cause instanceof ApiFailure ? ` (${cause.status})` : ''
    throw new Error(`Could not create the account${status}`, { cause })
  }
}

function useAuthentication(onAuthenticated: () => void) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function signIn(create: boolean): Promise<void> {
    setPending(true)
    setError('')
    try {
      if (create) await createAccount(email, password, inviteCode)
      const { data, error: failure } = await authClient.signIn.email({ email, password })
      if (failure) throw new Error(failure.message ?? 'Sign in failed')
      setPassword('')
      setInviteCode('')
      // During an MCP client's authorization the provider continues to consent; otherwise stay here.
      const next = redirectOf(data)
      if (next !== undefined && new URL(next, window.location.origin).pathname !== window.location.pathname)
        window.location.assign(next)
      else onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed')
    } finally {
      setPending(false)
    }
  }
  return { email, setEmail, password, setPassword, inviteCode, setInviteCode, pending, error, signIn }
}
type AuthenticationView = ReturnType<typeof useAuthentication>

function Credentials({ view, creating }: { readonly view: AuthenticationView; readonly creating: boolean }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          value={view.email}
          onChange={(event) => view.setEmail(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="password">Password</FieldLabel>
        <Input
          id="password"
          type="password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={view.password}
          onChange={(event) => view.setPassword(event.target.value)}
          minLength={creating ? 12 : 8}
          required
        />
      </Field>
    </>
  )
}

function AccountForm({
  view,
  mode,
  creating,
}: {
  readonly view: AuthenticationView
  readonly mode: SignupMode
  readonly creating: boolean
}) {
  const label = creating ? 'Create account' : 'Sign in'
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void view.signIn(creating)
      }}
    >
      <FieldGroup>
        <Credentials view={view} creating={creating} />
        {creating && mode === 'invite' && (
          <Field>
            <FieldLabel htmlFor="invite-code">Invite code</FieldLabel>
            <Input
              id="invite-code"
              type="password"
              autoComplete="off"
              value={view.inviteCode}
              onChange={(event) => view.setInviteCode(event.target.value)}
              required
            />
          </Field>
        )}
        <Field>
          <Button type="submit" disabled={view.pending}>
            {view.pending ? 'Working…' : label}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

export function Authentication({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const view = useAuthentication(onAuthenticated)
  const mode = useSignupMode()
  const [creating, setCreating] = useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{creating ? 'Create your Purrable' : 'Welcome to Purrable'}</CardTitle>
        <CardDescription>
          {creating ? 'You get your own resident agent.' : 'Sign in to your resident agent.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AccountForm view={view} mode={mode} creating={creating && mode !== 'closed'} />
        {mode !== 'closed' && (
          <Button variant="link" className="mt-4" onClick={() => setCreating(!creating)}>
            {creating ? 'I already have an account' : 'Create an account'}
          </Button>
        )}
      </CardContent>
      <CardFooter>
        {view.error && (
          <Alert variant="destructive">
            <AlertDescription>{view.error}</AlertDescription>
          </Alert>
        )}
      </CardFooter>
    </Card>
  )
}
