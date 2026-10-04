import { useEffect, useState } from 'react'
import { CatIcon, KeyRoundIcon } from 'lucide-react'
import {
  type AuthActionResult,
  AuthPage,
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  SignInMethods,
  type SignInMethod,
  failed,
  succeeded,
} from '@purrable/ui'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { ApiFailure, record, request } from '../lib/boundary.ts'

type SignupMode = 'open' | 'invite' | 'closed'
type AuthConfig = { readonly signup: SignupMode; readonly mail: boolean; readonly loaded: boolean }
type View = 'sign-in' | 'create' | 'reset'
type Notify = (message: string) => void
type Created =
  | { readonly ok: true; readonly confirmFirst: boolean }
  | { readonly ok: false; readonly result: AuthActionResult }

/** How this deployment admits accounts and whether it sends mail, from the public health endpoint. Unknown: none. */
function useAuthConfig(): AuthConfig {
  const [config, setConfig] = useState<AuthConfig>({ signup: 'closed', mail: false, loaded: false })
  useEffect(() => {
    const controller = new AbortController()
    void request('/health', { signal: controller.signal })
      .then((data) => {
        const health = record(data)
        const signup = health?.signup === 'open' || health?.signup === 'invite' ? health.signup : 'closed'
        if (!controller.signal.aborted) setConfig({ signup, mail: health?.mail === true, loaded: true })
      })
      .catch(() => {
        if (!controller.signal.aborted) setConfig({ signup: 'closed', mail: false, loaded: true })
      })
    return () => controller.abort()
  }, [])
  return config
}

const refusal = (status: number | undefined, fallback: string): AuthActionResult => {
  if (status === 403) return failed('Creating an account needs a valid invite code.')
  if (status === 429) return failed('Too many tries. Wait a minute and try again.')
  return failed(fallback)
}

/** During an MCP client's authorization the provider continues to consent; otherwise the caller's next step. */
function continueAfter(data: unknown, onAuthenticated: () => void): AuthActionResult {
  const next = redirectOf(data)
  if (next !== undefined && new URL(next, window.location.origin).pathname !== window.location.pathname)
    window.location.assign(next)
  else onAuthenticated()
  return succeeded
}

/** A password account. `confirmFirst` when the deployment requires email confirmation (no session yet). */
async function createAccount(email: string, password: string, inviteCode: string): Promise<Created> {
  try {
    // The confirmation link brings the user back here, so an MCP client's authorization can continue.
    const callbackURL = `${window.location.pathname}${window.location.search}`
    const created = await request('/api/auth/sign-up/email', {
      body: { email, password, name: email.split('@')[0] ?? email, callbackURL },
      headers: inviteCode ? { 'x-invite-code': inviteCode } : {},
    })
    return { ok: true, confirmFirst: typeof record(created)?.token !== 'string' }
  } catch (cause) {
    const status = cause instanceof ApiFailure ? cause.status : undefined
    return { ok: false, result: refusal(status, 'Could not create the account.') }
  }
}

/** The app's side of the shared sign-in form: Better Auth calls, the invite header and where to go next. */
function signInActions(inviteCode: string, creating: boolean, onAuthenticated: () => void, notify: Notify) {
  const fetchOptions = { headers: inviteCode ? { 'x-invite-code': inviteCode } : {} }
  const emailCode = {
    onRequestCode: async (email: string): Promise<AuthActionResult> => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions })
      return error ? refusal(error.status, 'Could not send a code. Try again.') : succeeded
    },
    onVerifyCode: async (email: string, otp: string): Promise<AuthActionResult> => {
      const { data, error } = await authClient.signIn.emailOtp({ email, otp, fetchOptions })
      if (error) return refusal(error.status, 'That code did not work. Check it or get a new one.')
      return continueAfter(data, onAuthenticated)
    },
  }
  const password = {
    onSubmit: async (email: string, secret: string): Promise<AuthActionResult> => {
      if (creating) {
        const created = await createAccount(email, secret, inviteCode)
        if (!created.ok) return created.result
        if (created.confirmFirst) {
          notify(`We sent a confirmation link to ${email}. Open it to finish; it signs you in.`)
          return succeeded
        }
      }
      const { data, error } = await authClient.signIn.email({ email, password: secret })
      if (error?.status === 403) return failed(`Confirm your email first: we sent a new link to ${email}.`)
      return error ? failed('Wrong email or password.') : continueAfter(data, onAuthenticated)
    },
  }
  const passkey = {
    onSignIn: async (): Promise<AuthActionResult> => {
      const result = await authClient.signIn.passkey()
      return result?.error ? failed('Could not sign in with a passkey.') : continueAfter(result?.data, onAuthenticated)
    },
  }
  return { emailCode, password, passkey }
}

function InviteField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="invite-code">Invite code</FieldLabel>
        <Input
          id="invite-code"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <FieldDescription>Purrable is invite-only for now.</FieldDescription>
      </Field>
    </FieldGroup>
  )
}

/** "Forgot your password": one field; the answer never says whether the address has an account. */
function ResetRequest({ notify }: { readonly notify: Notify }) {
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  async function send(): Promise<void> {
    setPending(true)
    await request('/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } }).catch(
      () => undefined,
    )
    setPending(false)
    notify(`If ${email} has an account with a password, a link to choose a new one is on its way.`)
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="reset-email">Email</FieldLabel>
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          <KeyRoundIcon data-icon="inline-start" />
          Email me a reset link
        </Button>
      </FieldGroup>
    </form>
  )
}

const TITLES: Record<View, { readonly title: string; readonly description: string }> = {
  'sign-in': { title: 'Sign in to Purrable', description: 'Your own resident agent, always on.' },
  create: { title: 'Create your Purrable', description: 'You get your own resident agent.' },
  reset: { title: 'Reset your password', description: 'We email you a link to choose a new one.' },
}

/** A passkey signs in to an existing account only, so creating one offers the email methods. */
const methodsFor = (view: View, config: AuthConfig): SignInMethod[] => [
  ...(config.mail ? (['email-otp'] as const) : []),
  'password',
  ...(view === 'sign-in' ? (['passkey'] as const) : []),
]

/** Quiet text links under the form; the page footer styles its buttons like links (adapted from the myapps footer). */
function Footer(props: { readonly view: View; readonly config: AuthConfig; readonly go: (view: View) => void }) {
  if (props.view !== 'sign-in')
    return (
      <p>
        <button type="button" onClick={() => props.go('sign-in')}>
          Back to sign in
        </button>
      </p>
    )
  return (
    <>
      {props.config.signup !== 'closed' && (
        <p>
          New here?{' '}
          <button type="button" onClick={() => props.go('create')}>
            Create an account
          </button>
        </p>
      )}
      {props.config.mail && (
        <p>
          <button type="button" onClick={() => props.go('reset')}>
            Forgot your password?
          </button>
        </p>
      )}
    </>
  )
}

/** Sign in or create an account: with mail, an emailed code first and a password behind it; without mail, a password. */
export function Authentication({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const config = useAuthConfig()
  const [view, setView] = useState<View>('sign-in')
  const [inviteCode, setInviteCode] = useState('')
  const [notice, setNotice] = useState('')
  const creating = view === 'create'
  const actions = signInActions(inviteCode, creating, onAuthenticated, setNotice)
  const go = (next: View) => {
    setNotice('')
    setView(next)
  }
  return (
    <AuthPage
      as="section"
      mark={<CatIcon />}
      title={TITLES[view].title}
      description={TITLES[view].description}
      footer={<Footer view={view} config={config} go={go} />}
    >
      {creating && config.signup === 'invite' && <InviteField value={inviteCode} onChange={setInviteCode} />}
      {/* The form picks its first method when it mounts, so it waits until the deployment says whether it sends mail. */}
      {!config.loaded ? null : view === 'reset' ? (
        <ResetRequest notify={setNotice} />
      ) : (
        <SignInMethods
          key={view}
          methods={methodsFor(view, config)}
          emailCode={actions.emailCode}
          password={actions.password}
          passkey={actions.passkey}
          labels={creating ? { signIn: 'Create account', requestCode: 'Email me a code to start' } : {}}
        />
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </AuthPage>
  )
}
