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
import { EmailCodeSignIn } from './email-code.tsx'
import { ApiFailure, record, request } from '../lib/boundary.ts'

type SignupMode = 'open' | 'invite' | 'closed'
type AuthConfig = { readonly signup: SignupMode; readonly mail: boolean }

/** How this deployment admits accounts and whether it sends mail, from the public health endpoint. Unknown: none. */
function useAuthConfig(): AuthConfig {
  const [config, setConfig] = useState<AuthConfig>({ signup: 'closed', mail: false })
  useEffect(() => {
    const controller = new AbortController()
    void request('/health', { signal: controller.signal })
      .then((data) => {
        const health = record(data)
        const signup = health?.signup === 'open' || health?.signup === 'invite' ? health.signup : 'closed'
        if (!controller.signal.aborted) setConfig({ signup, mail: health?.mail === true })
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  return config
}

/** Creates the account; `false` when it must be confirmed by email first (no session was started). */
async function createAccount(email: string, password: string, inviteCode: string): Promise<boolean> {
  try {
    // The confirmation link brings the user back here, so an MCP client's authorization can continue.
    const callbackURL = `${window.location.pathname}${window.location.search}`
    const created = await request('/api/auth/sign-up/email', {
      body: { email, password, name: email.split('@')[0] ?? email, callbackURL },
      headers: inviteCode ? { 'x-invite-code': inviteCode } : {},
    })
    return typeof record(created)?.token === 'string'
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
  const [notice, setNotice] = useState('')
  async function signIn(create: boolean): Promise<void> {
    setPending(true)
    setError('')
    setNotice('')
    try {
      if (create && !(await createAccount(email, password, inviteCode))) {
        setPassword('')
        setInviteCode('')
        setNotice(`We sent a confirmation link to ${email}. Open it to finish; it signs you in.`)
        return
      }
      const { data, error: failure } = await authClient.signIn.email({ email, password })
      if (failure?.status === 403) throw new Error(`Confirm your email first: we sent a new link to ${email}.`)
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
  /** The answer never says whether the address has an account. */
  async function requestReset(): Promise<void> {
    setError('')
    setNotice('')
    if (!email) {
      setError('Enter your email first.')
      return
    }
    setPending(true)
    try {
      await request('/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } })
      setNotice(`If ${email} has an account, we sent it a link to choose a new password.`)
    } catch {
      setError('Could not send the reset link. Try again in a while.')
    } finally {
      setPending(false)
    }
  }
  return {
    email,
    setEmail,
    password,
    setPassword,
    inviteCode,
    setInviteCode,
    pending,
    error,
    setError,
    notice,
    setNotice,
    signIn,
    requestReset,
  }
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

function PasswordSignIn({ view, signup: mode, mail }: { readonly view: AuthenticationView } & AuthConfig) {
  const [creating, setCreating] = useState(false)
  return (
    <>
      <AccountForm view={view} mode={mode} creating={creating && mode !== 'closed'} />
      <div className="mt-4 flex flex-wrap gap-2">
        {mode !== 'closed' && (
          <Button variant="link" onClick={() => setCreating(!creating)}>
            {creating ? 'I already have an account' : 'Create an account with a password'}
          </Button>
        )}
        {mail && !creating && (
          <Button variant="link" disabled={view.pending} onClick={() => void view.requestReset()}>
            Forgot password?
          </Button>
        )}
      </div>
    </>
  )
}

/** With mail, an emailed code is the way in (a new address gets an account); a password stays as the fallback. */
export function Authentication({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const view = useAuthentication(onAuthenticated)
  const config = useAuthConfig()
  const [withPassword, setWithPassword] = useState(false)
  const codes = config.mail && !withPassword
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome to Purrable</CardTitle>
        <CardDescription>Sign in, or create your own resident agent.</CardDescription>
      </CardHeader>
      <CardContent>
        {codes ? (
          <EmailCodeSignIn
            invite={config.signup === 'invite'}
            feedback={{ error: view.setError, notice: view.setNotice }}
            onAuthenticated={onAuthenticated}
          />
        ) : (
          <PasswordSignIn view={view} {...config} />
        )}
        {config.mail && (
          <Button
            variant="link"
            className="mt-2"
            onClick={() => {
              view.setError('')
              view.setNotice('')
              setWithPassword(!withPassword)
            }}
          >
            {withPassword ? 'Email me a code instead' : 'Use a password instead'}
          </Button>
        )}
      </CardContent>
      <CardFooter>
        {view.error && (
          <Alert variant="destructive">
            <AlertDescription>{view.error}</AlertDescription>
          </Alert>
        )}
        {view.notice && (
          <Alert>
            <AlertDescription>{view.notice}</AlertDescription>
          </Alert>
        )}
      </CardFooter>
    </Card>
  )
}
