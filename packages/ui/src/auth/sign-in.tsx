// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
/**
 * The sign-in methods: one Email field shared by an emailed code (offered first) and the password (opened with "Use a
 * password instead"). The form owns only its fields and busy state; the app's callback does the auth
 * call and, on success, the navigation (its OAuth continuation or a checked path).
 */
import { LockKeyholeIcon, LogInIcon, MailIcon, PencilLineIcon, RotateCwIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '../components/button.tsx'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../components/field.tsx'
import { Input } from '../components/input.tsx'
import { ActionIcon } from './action-icon.tsx'
import {
  type AuthActionResult,
  codeDigits,
  EMAIL_METHODS,
  type EmailCodeStage,
  type EmailMethod,
  failed,
  labelsWith,
  type SignInLabels,
  type SignInMethod,
} from './contract.ts'
import { type ActionState, useAction } from './use-action.ts'

/** The emailed code: request it for an email, then sign in with it (sign-in only: existing, verified accounts). */
export interface EmailCodeMethod {
  readonly onRequestCode: (email: string) => Promise<AuthActionResult>
  /** Signs in with the code; on success the app navigates. */
  readonly onVerifyCode: (email: string, code: string) => Promise<AuthActionResult>
  readonly codeLength?: number | undefined
}

/** Email and password; public sign-up is app policy, not part of this form. */
export interface PasswordMethod {
  /** Signs in with email and password; on success the app navigates. */
  readonly onSubmit: (email: string, password: string) => Promise<AuthActionResult>
}

export interface EmailSignInFormProps {
  /** The emailed code; offered first when given. */
  readonly emailCode?: EmailCodeMethod | undefined
  /** The password; behind "Use a password instead" when the emailed code is offered too. */
  readonly password?: PasswordMethod | undefined
  readonly initialEmail?: string | undefined
  readonly disabled?: boolean | undefined
  readonly labels?: Partial<SignInLabels> | undefined
}

interface EmailSignIn {
  readonly labels: SignInLabels
  readonly methods: readonly EmailMethod[]
  readonly method: EmailMethod
  readonly stage: EmailCodeStage
  readonly email: string
  readonly password: string
  readonly code: string
  readonly codeLength: number
  /** Move focus to the email after "Use a different email". */
  readonly focusEmail: boolean
  readonly action: ActionState
  readonly locked: boolean
  readonly setEmail: (email: string) => void
  readonly setPassword: (password: string) => void
  readonly enterCode: (value: string) => void
  readonly submit: () => Promise<boolean>
  readonly resend: () => Promise<boolean>
  readonly changeEmail: () => void
  readonly switchMethod: () => void
}

/** The state behind the form: the active method, the code stage, the fields and the one action at a time. */
function useEmailSignIn(props: EmailSignInFormProps): EmailSignIn {
  const labels = labelsWith(props.labels)
  const { emailCode, password: passwordMethod } = props
  const methods = EMAIL_METHODS.filter((method) => (method === 'email-otp' ? emailCode : passwordMethod) !== undefined)
  const [method, setMethod] = useState<EmailMethod>(methods[0] ?? 'email-otp')
  const [stage, setStage] = useState<EmailCodeStage>('email')
  const [email, setEmail] = useState(props.initialEmail ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [focusEmail, setFocusEmail] = useState(false)
  const action = useAction(labels.failed)
  const locked = action.busy || props.disabled === true
  const codeLength = emailCode?.codeLength ?? 6
  const unavailable = () => Promise.resolve(failed(labels.failed))
  const resend = async () => {
    const sent = await action.run(() => emailCode?.onRequestCode(email.trim()) ?? unavailable())
    if (sent) {
      setCode('')
      setStage('code')
    }
    return sent
  }
  const verify = (value: string) => action.run(() => emailCode?.onVerifyCode(email.trim(), value) ?? unavailable())
  const submit = () => {
    if (method === 'password')
      return action.run(() => passwordMethod?.onSubmit(email.trim(), password) ?? unavailable())
    return stage === 'email' ? resend() : verify(code)
  }
  const enterCode = (value: string) => {
    const digits = codeDigits(value, codeLength)
    setCode(digits)
    // A pasted or autofilled code is complete: sign in without waiting for the button.
    if (digits.length === codeLength && digits !== code && !locked) void verify(digits)
  }
  const changeEmail = () => {
    setStage('email')
    setCode('')
    setFocusEmail(true)
    action.clearError()
  }
  const switchMethod = () => {
    setMethod(method === 'password' ? 'email-otp' : 'password')
    setStage('email')
    action.clearError()
  }
  return {
    labels,
    methods,
    method,
    stage,
    email,
    password,
    code,
    codeLength,
    focusEmail,
    action,
    locked,
    setEmail,
    setPassword,
    enterCode,
    submit,
    resend,
    changeEmail,
    switchMethod,
  }
}

/** The action that submits the form, by method and stage. */
const SUBMIT: Record<
  'request' | 'verify' | 'password',
  { readonly icon: typeof MailIcon; readonly label: keyof SignInLabels }
> = {
  request: { icon: MailIcon, label: 'requestCode' },
  verify: { icon: LogInIcon, label: 'verifyCode' },
  password: { icon: LogInIcon, label: 'signIn' },
}

/**
 * One Email field for the emailed code and the password. The form's `data-method` is the active method, so a
 * script finds `form[data-method=password] input[type=password]` once that method is open.
 */
export function EmailSignInForm(props: EmailSignInFormProps) {
  const form = useEmailSignIn(props)
  const id = useId()
  const { labels, method, action } = form
  const inCode = method === 'email-otp' && form.stage === 'code'
  const submit = SUBMIT[method === 'password' ? 'password' : inCode ? 'verify' : 'request']
  return (
    <form
      data-method={method}
      data-stage={method === 'email-otp' ? form.stage : undefined}
      onSubmit={(event) => {
        event.preventDefault()
        void form.submit()
      }}
    >
      <FieldGroup>
        {inCode ? <CodeField form={form} id={`${id}-code`} /> : <EmailField form={form} id={`${id}-email`} />}
        {method === 'password' ? <PasswordField form={form} id={`${id}-password`} /> : null}
        {action.error === null ? null : <FieldError>{action.error}</FieldError>}
        <div className="flex flex-col gap-2">
          <Button type="submit" size="lg" className="w-full" disabled={form.locked} aria-busy={action.busy}>
            <ActionIcon icon={submit.icon} busy={action.busy} />
            {labels[submit.label]}
          </Button>
          {inCode ? <CodeActions form={form} /> : <MethodSwitch form={form} />}
        </div>
      </FieldGroup>
    </form>
  )
}

interface PartProps {
  readonly form: EmailSignIn
  readonly id: string
}

function EmailField({ form, id }: PartProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{form.labels.email}</FieldLabel>
      <Input
        id={id}
        type="email"
        name="email"
        autoComplete={form.method === 'password' ? 'username' : 'email'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        autoFocus={form.focusEmail}
        value={form.email}
        disabled={form.locked}
        onChange={(event) => form.setEmail(event.target.value)}
      />
    </Field>
  )
}

function PasswordField({ form, id }: PartProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{form.labels.password}</FieldLabel>
      <Input
        id={id}
        type="password"
        name="password"
        autoComplete="current-password"
        required
        autoFocus={form.email.trim() !== ''}
        value={form.password}
        disabled={form.locked}
        onChange={(event) => form.setPassword(event.target.value)}
      />
    </Field>
  )
}

/** The code sent to the email: digits only, submitted as soon as it is complete. */
function CodeField({ form, id }: PartProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{form.labels.code}</FieldLabel>
      <Input
        id={id}
        variant="code"
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern={`[0-9]{${form.codeLength}}`}
        maxLength={form.codeLength}
        required
        autoFocus
        value={form.code}
        disabled={form.locked}
        onChange={(event) => form.enterCode(event.target.value)}
      />
      <FieldDescription role="status">
        <span className="font-medium break-all text-foreground">{form.email.trim()}</span>. {form.labels.codeSent}
      </FieldDescription>
    </Field>
  )
}

/** Resend the code or go back to the email, on one row. */
function CodeActions({ form }: { readonly form: EmailSignIn }) {
  return (
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
  )
}

/** "Use a password instead" (or back to the emailed code), when both methods are offered. */
function MethodSwitch({ form }: { readonly form: EmailSignIn }) {
  if (form.methods.length < 2) return null
  const toPassword = form.method === 'email-otp'
  return (
    <Button
      type="button"
      variant="ghost"
      size="lg"
      className="w-full"
      data-switch-method={toPassword ? 'password' : 'email-otp'}
      disabled={form.locked}
      onClick={form.switchMethod}
    >
      <ActionIcon icon={toPassword ? LockKeyholeIcon : MailIcon} />
      {toPassword ? form.labels.usePassword : form.labels.useEmailCode}
    </Button>
  )
}

export interface SignInMethodsProps {
  /** The methods to offer; a method shows only with its callbacks. */
  readonly methods: readonly SignInMethod[]
  readonly emailCode?: EmailCodeMethod | undefined
  readonly password?: PasswordMethod | undefined
  readonly initialEmail?: string | undefined
  readonly disabled?: boolean | undefined
  readonly labels?: Partial<SignInLabels> | undefined
}

/** Every enabled email method, the same way in every app. */
export function SignInMethods(props: SignInMethodsProps) {
  const offered = (method: SignInMethod) => props.methods.includes(method)
  return (
    <div data-slot="sign-in-methods" className="flex flex-col gap-6">
      <EmailSignInForm
        emailCode={offered('email-otp') ? props.emailCode : undefined}
        password={offered('password') ? props.password : undefined}
        initialEmail={props.initialEmail}
        disabled={props.disabled}
        labels={props.labels}
      />
    </div>
  )
}
