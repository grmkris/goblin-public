// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
/**
 * The sign-in contract: the methods, the view states, the result of an action and the default labels. Components own
 * no endpoint or Better Auth instance: the app passes callbacks and decides where to go on success.
 */
/** The sign-in methods, in the order they are offered. */
export const SIGN_IN_METHODS = ['email-otp', 'password', 'passkey'] as const
export type SignInMethod = (typeof SIGN_IN_METHODS)[number]

/**
 * What an action callback reports. On failure the message is shown as given: keep it generic (never whether an
 * account exists, never a provider error).
 */
export type AuthActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

export const succeeded: AuthActionResult = { ok: true }
export const failed = (error: string): AuthActionResult => ({ ok: false, error })

/**
 * The methods that share the one Email field: an emailed code (offered first) and the password, which the person opens
 * with "Use a password instead". The form carries the active one as `data-method`, so `form[data-method=password]`
 * finds the email and password fields once that method is open.
 */
export const EMAIL_METHODS = ['email-otp', 'password'] as const satisfies readonly SignInMethod[]
export type EmailMethod = (typeof EMAIL_METHODS)[number]

/** The two stages of an emailed code: ask for the email, then for the code sent to it. */
export type EmailCodeStage = 'email' | 'code'

/** Default English labels; an app overrides any of them. */
export const SIGN_IN_LABELS = {
  email: 'Email',
  password: 'Password',
  code: 'Sign-in code',
  requestCode: 'Email me a code',
  verifyCode: 'Sign in with code',
  resendCode: 'Send a new code',
  changeEmail: 'Use a different email',
  codeSent: 'If an account uses this email, a six-digit code will arrive shortly. Use the most recent code.',
  usePassword: 'Use a password instead',
  useEmailCode: 'Email me a code instead',
  signIn: 'Sign in',
  failed: 'Something went wrong. Check your connection and try again.',
} as const

export type SignInLabels = { readonly [K in keyof typeof SIGN_IN_LABELS]: string }

/** The labels with the app's overrides. */
export const labelsWith = (overrides: Partial<SignInLabels> = {}): SignInLabels => ({ ...SIGN_IN_LABELS, ...overrides })

/** The code with everything but digits removed, at most `length` digits. */
export const codeDigits = (value: string, length = 6): string => value.replace(/\D/g, '').slice(0, length)
