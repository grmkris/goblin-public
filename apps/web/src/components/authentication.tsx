import { useEffect, useState } from 'react'
import {
  type AuthActionResult,
  EmailSignInForm,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Skeleton,
  failed,
  succeeded,
} from '@goblin/ui'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { record, request } from '../lib/boundary.ts'
import { AuthShell } from './auth-shell.tsx'

type SignupMode = 'open' | 'invite' | 'closed'
type AuthConfig = { readonly signup: SignupMode; readonly mail: boolean; readonly loaded: boolean }
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
  if (status === 403) return failed('New accounts need a valid invite. Existing users can sign in.')
  if (status === 429) return failed('Too many tries. Wait a minute and try again.')
  return failed(fallback)
}
function continueAfter(data: unknown, onAuthenticated: () => void): AuthActionResult {
  const next = redirectOf(data)
  if (next !== undefined && new URL(next, window.location.origin).pathname !== window.location.pathname)
    window.location.assign(next)
  else onAuthenticated()
  return succeeded
}
function codeActions(inviteCode: string, onAuthenticated: () => void) {
  const fetchOptions = { headers: inviteCode ? { 'x-invite-code': inviteCode } : {} }
  return {
    onRequestCode: async (email: string): Promise<AuthActionResult> => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions })
      return error ? refusal(error.status, 'Could not send a code. Try again.') : succeeded
    },
    onVerifyCode: async (email: string, otp: string): Promise<AuthActionResult> => {
      const { data, error } = await authClient.signIn.emailOtp({ email, otp, fetchOptions })
      return error
        ? refusal(error.status, 'That code did not work. Check it or get a new one.')
        : continueAfter(data, onAuthenticated)
    },
  }
}
export function Authentication({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const config = useAuthConfig()
  const [inviteCode, setInviteCode] = useState('')
  const [creating, setCreating] = useState(false)
  return (
    <AuthShell
      title={creating ? 'Meet your goblin' : 'Sign in to goblin'}
      description="Your own resident agent, always on."
      footer={
        config.signup !== 'closed' && (
          <p>
            <button type="button" onClick={() => setCreating(!creating)}>
              {creating ? 'Back to sign in' : 'New here? Create an account'}
            </button>
          </p>
        )
      }
    >
      {creating && config.signup === 'invite' && (
        <Field>
          <FieldLabel htmlFor="invite-code">Invite code</FieldLabel>
          <Input
            id="invite-code"
            type="password"
            autoComplete="off"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <FieldDescription>goblin is invite-only for now.</FieldDescription>
        </Field>
      )}
      {!config.loaded ? (
        <div className="auth-body" aria-busy>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : config.mail ? (
        <EmailSignInForm key={String(creating)} emailCode={codeActions(creating ? inviteCode : '', onAuthenticated)} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Sign-in mail is temporarily unavailable. Please try again later.
        </p>
      )}
    </AuthShell>
  )
}
