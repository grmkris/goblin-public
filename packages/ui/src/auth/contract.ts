// Adapted from grmkris/myapps packages/ui/src/auth (9616f76).
export type AuthActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }
export const succeeded: AuthActionResult = { ok: true }
export const failed = (error: string): AuthActionResult => ({ ok: false, error })
export type EmailCodeStage = 'email' | 'code'
export const SIGN_IN_LABELS = {
  email: 'Email',
  code: 'Sign-in code',
  requestCode: 'Email me a code',
  verifyCode: 'Sign in with code',
  resendCode: 'Send a new code',
  changeEmail: 'Use a different email',
  codeSent: 'A six-digit code is on its way. Use the most recent code; it expires in 10 minutes.',
  failed: 'Something went wrong. Check your connection and try again.',
} as const
export type SignInLabels = { readonly [K in keyof typeof SIGN_IN_LABELS]: string }
export const labelsWith = (overrides: Partial<SignInLabels> = {}): SignInLabels => ({ ...SIGN_IN_LABELS, ...overrides })
export const codeDigits = (value: string, length = 6): string => value.replace(/\D/g, '').slice(0, length)
