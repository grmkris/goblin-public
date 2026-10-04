import { useState } from 'react'
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input } from '@purrable/ui'
import { authClient, redirectOf } from '../lib/auth-client.ts'

type Feedback = { readonly error: (message: string) => void; readonly notice: (message: string) => void }

const failureMessage = (status: number | undefined, fallback: string): string => {
  if (status === 403) return 'Creating an account needs a valid invite code.'
  if (status === 429) return 'Too many tries. Wait a minute and ask for a new code.'
  return fallback
}

function useEmailCode(feedback: Feedback, onAuthenticated: () => void) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [pending, setPending] = useState(false)
  const fetchOptions = { headers: inviteCode ? { 'x-invite-code': inviteCode } : {} }

  async function send(): Promise<void> {
    setPending(true)
    feedback.error('')
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions })
    setPending(false)
    if (error) return feedback.error(failureMessage(error.status, 'Could not send a code. Try again.'))
    setStep('code')
    feedback.notice(`We sent a six-digit code to ${email}. It works for 10 minutes.`)
  }

  async function verify(): Promise<void> {
    setPending(true)
    feedback.error('')
    const { data, error } = await authClient.signIn.emailOtp({ email, otp: code, fetchOptions })
    setPending(false)
    setCode('')
    if (error) return feedback.error(failureMessage(error.status, 'That code did not work. Check it or get a new one.'))
    feedback.notice('')
    // During an MCP client's authorization the provider continues to consent; otherwise stay here.
    const next = redirectOf(data)
    if (next !== undefined && new URL(next, window.location.origin).pathname !== window.location.pathname)
      window.location.assign(next)
    else onAuthenticated()
  }

  return { step, setStep, email, setEmail, code, setCode, inviteCode, setInviteCode, pending, send, verify }
}
type EmailCode = ReturnType<typeof useEmailCode>

function InviteField({ flow }: { readonly flow: EmailCode }) {
  return (
    <Field>
      <FieldLabel htmlFor="code-invite">Invite code</FieldLabel>
      <Input
        id="code-invite"
        type="password"
        autoComplete="off"
        value={flow.inviteCode}
        onChange={(event) => flow.setInviteCode(event.target.value)}
      />
      <FieldDescription>Only needed the first time, to create your account.</FieldDescription>
    </Field>
  )
}

function CodeField({ flow }: { readonly flow: EmailCode }) {
  return (
    <Field>
      <FieldLabel htmlFor="code-otp">Code</FieldLabel>
      <Input
        id="code-otp"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={flow.code}
        onChange={(event) => flow.setCode(event.target.value)}
        required
      />
    </Field>
  )
}

/** Sign-in by emailed code: the address, then the six-digit code. A new address becomes an account (with an invite). */
export function EmailCodeSignIn(props: {
  readonly invite: boolean
  readonly feedback: Feedback
  readonly onAuthenticated: () => void
}) {
  const flow = useEmailCode(props.feedback, props.onAuthenticated)
  const asking = flow.step === 'email'
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void (asking ? flow.send() : flow.verify())
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="code-email">Email</FieldLabel>
          <Input
            id="code-email"
            type="email"
            autoComplete="username"
            value={flow.email}
            disabled={!asking}
            onChange={(event) => flow.setEmail(event.target.value)}
            required
          />
        </Field>
        {asking && props.invite && <InviteField flow={flow} />}
        {!asking && <CodeField flow={flow} />}
        <Field>
          <Button type="submit" disabled={flow.pending}>
            {flow.pending ? 'Working…' : asking ? 'Email me a code' : 'Sign in'}
          </Button>
          {!asking && (
            <Button type="button" variant="link" disabled={flow.pending} onClick={() => flow.setStep('email')}>
              Use another address or send a new code
            </Button>
          )}
        </Field>
      </FieldGroup>
    </form>
  )
}
