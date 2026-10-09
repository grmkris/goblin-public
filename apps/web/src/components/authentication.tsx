import { type ReactNode, useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert,
  AlertDescription,
  type AuthActionResult,
  Button,
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
import { healthQuery } from '../auth/queries.ts'
import { AuthShell } from './auth-shell.tsx'

type SignupMode = 'open' | 'invite' | 'closed'
/** `failed`: `/health` could not be read, so whether sign-in mail and sign-up are on is unknown, not off. */
type AuthConfig = {
  readonly signup: SignupMode
  readonly mail: boolean
  readonly status: 'loading' | 'loaded' | 'failed'
  readonly retry: () => void
}
function useAuthConfig(): AuthConfig {
  const read = useQuery(healthQuery)
  const { refetch } = read
  const retry = useCallback(() => void refetch(), [refetch])
  if (read.data !== undefined) return { ...read.data, status: 'loaded', retry }
  return { signup: 'closed', mail: false, status: read.isError && !read.isFetching ? 'failed' : 'loading', retry }
}
/** What the form shows once the settings are read: the email form, or why there is none. */
function SignInBody({ config, form }: { readonly config: AuthConfig; readonly form: ReactNode }) {
  if (config.status === 'loading')
    return (
      <div className="auth-body" aria-busy>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  if (config.status === 'failed')
    return (
      <div className="auth-body">
        <Alert variant="destructive">
          <AlertDescription>Could not reach goblin. Check your connection and try again.</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={config.retry}>
          Try again
        </Button>
      </div>
    )
  if (config.mail) return form
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Sign-in mail is temporarily unavailable. Please try again later.
    </p>
  )
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
      <SignInBody
        config={config}
        form={
          <EmailSignInForm
            key={String(creating)}
            emailCode={codeActions(creating ? inviteCode : '', onAuthenticated)}
          />
        }
      />
    </AuthShell>
  )
}
