import { APIError } from 'better-auth/api'
import type { AuthEnvironment } from '../auth/options.ts'
import { CODE_SIGN_IN } from '../auth/email-code.ts'
import { signupAllowed, signupMode } from '../auth/signup.ts'
import { admissionToken, readAdmission } from './proof.ts'

type Context = { readonly path?: string; readonly headers?: Headers | undefined } | null
/** Hook is checked before and after creation. An orphan from a failed after hook remains unprovisioned. */
export async function createdAccountKind(database: D1Database, env: AuthEnvironment, context: Context, email: string) {
  let admission
  try {
    admission = await readAdmission(database, context?.headers, email)
  } catch {
    if (admissionToken(context?.headers) !== undefined)
      throw new APIError('FORBIDDEN', { message: 'Invitation admission required.' })
  }
  if (admission !== undefined) {
    if (context?.path !== CODE_SIGN_IN || admission.admission.state !== 'active')
      throw new APIError('FORBIDDEN', { message: 'Use the invited email sign-in code.' })
    return 'invitation' as const
  }
  const presented = context?.headers?.get('x-invite-code') ?? ''
  if (
    !signupAllowed(signupMode(env.SIGNUP_MODE), env.SIGNUP_INVITE_CODE ?? '', presented) ||
    (context?.path !== '/sign-up/email' && context?.path !== CODE_SIGN_IN)
  )
    throw new APIError('FORBIDDEN', { message: 'Sign-up is closed.' })
  return 'ordinary' as const
}
