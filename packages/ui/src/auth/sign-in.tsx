// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): emailed-code sign-in.
import { LogInIcon, MailIcon, PencilLineIcon, RotateCwIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../components/button.tsx'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/field.tsx'
import { Input } from '../components/input.tsx'
import { ActionIcon } from './action-icon.tsx'
import { type AuthActionResult, codeDigits, type EmailCodeStage, labelsWith, type SignInLabels } from './contract.ts'
import { useAction } from './use-action.ts'

export interface EmailCodeMethod {
  readonly onRequestCode: (email: string) => Promise<AuthActionResult>
  readonly onVerifyCode: (email: string, code: string) => Promise<AuthActionResult>
}
export interface EmailSignInFormProps {
  readonly emailCode: EmailCodeMethod
  readonly initialEmail?: string | undefined
  readonly disabled?: boolean | undefined
  readonly labels?: Partial<SignInLabels> | undefined
}

function useEmailCode(props: EmailSignInFormProps) {
  const labels = labelsWith(props.labels)
  const [stage, setStage] = useState<EmailCodeStage>('email')
  const [email, setEmail] = useState(props.initialEmail ?? '')
  const [code, setCode] = useState('')
  const [focusEmail, setFocusEmail] = useState(false)
  const action = useAction(labels.failed)
  const locked = action.busy || props.disabled === true
  // While a request is out the fields are read-only, not disabled: disabling takes the focus, which closes a phone's
  // keyboard, and a mistyped code would then need a tap before it can be typed again.
  const blocked = props.disabled === true
  const resend = async () => {
    const sent = await action.run(() => props.emailCode.onRequestCode(email.trim()))
    if (sent) {
      setCode('')
      setStage('code')
    }
    return sent
  }
  const verify = (value: string) => action.run(() => props.emailCode.onVerifyCode(email.trim(), value))
  const submit = () => (stage === 'email' ? resend() : verify(code))
  const enterCode = (value: string) => {
    const digits = codeDigits(value)
    setCode(digits)
    // expected: action.run turns every failure into the form's error, so it never rejects
    if (digits.length === 6 && digits !== code && !locked) verify(digits).catch(() => false)
  }
  const changeEmail = () => {
    setStage('email')
    setCode('')
    setFocusEmail(true)
    action.clearError()
  }
  return {
    labels,
    stage,
    email,
    code,
    focusEmail,
    action,
    locked,
    blocked,
    setEmail,
    enterCode,
    submit,
    resend,
    changeEmail,
  }
}

/** One email field, then the delivered six-digit code. The app owns auth and OAuth continuation. */
export function EmailSignInForm(props: EmailSignInFormProps) {
  const form = useEmailCode(props)
  const id = useId()
  const inCode = form.stage === 'code'
  return (
    <form
      data-method="email-otp"
      data-stage={form.stage}
      onSubmit={(event) => {
        event.preventDefault()
        // expected: action.run turns every failure into the form's error, so it never rejects
        form.submit().catch(() => false)
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{inCode ? form.labels.code : form.labels.email}</FieldLabel>
          {inCode ? (
            <Input
              key="code"
              id={id}
              variant="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={form.code}
              disabled={form.blocked}
              readOnly={form.action.busy}
              onChange={(event) => form.enterCode(event.target.value)}
            />
          ) : (
            <Input
              key="email"
              id={id}
              type="email"
              name="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              autoFocus={form.focusEmail}
              value={form.email}
              disabled={form.blocked}
              readOnly={form.action.busy}
              onChange={(event) => form.setEmail(event.target.value)}
            />
          )}
          {inCode && (
            <FieldDescription role="status">
              <span className="font-medium break-all text-foreground">{form.email.trim()}</span>. {form.labels.codeSent}
            </FieldDescription>
          )}
        </Field>
        {form.action.error !== null && <FieldError>{form.action.error}</FieldError>}
        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" className="w-full" disabled={form.locked} aria-busy={form.action.busy}>
            <ActionIcon icon={inCode ? LogInIcon : MailIcon} busy={form.action.busy} />
            {inCode ? form.labels.verifyCode : form.labels.requestCode}
          </Button>
          {inCode && (
            <div className="flex flex-wrap items-center justify-center gap-x-1">
              <Button type="button" variant="ghost" size="lg" disabled={form.locked} onClick={() => void form.resend()}>
                <RotateCwIcon data-icon="inline-start" />
                {form.labels.resendCode}
              </Button>
              <Button type="button" variant="ghost" size="lg" disabled={form.locked} onClick={form.changeEmail}>
                <PencilLineIcon data-icon="inline-start" />
                {form.labels.changeEmail}
              </Button>
            </div>
          )}
        </div>
      </FieldGroup>
    </form>
  )
}
