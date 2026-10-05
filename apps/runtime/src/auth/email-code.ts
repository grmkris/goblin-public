import { APIError, type createAuthMiddleware } from 'better-auth/api'
import { Predicate } from 'effect'
import type { AuthEnvironment } from './options.ts'
import { canonicalEmail, signupAllowed, signupMode } from './signup.ts'
import { admissionToken, readAdmission } from '../workspaces/proof.ts'

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

export const CODE_SEND = '/email-otp/send-verification-otp'
export const CODE_SIGN_IN = '/sign-in/email-otp'
/** One code per address per minute, whoever asks: many IPs cannot mail-bomb one inbox. */
export const CODE_COOLDOWN_MS = 60_000

const isCodePath = (path: string): boolean =>
  path.startsWith('/email-otp/') || path === CODE_SIGN_IN || path === '/forget-password/email-otp'

const millis = (value: string | number | null | undefined): number =>
  Predicate.isNumber(value) ? value : Predicate.isString(value) ? Date.parse(value) : Number.NaN

/** When the latest sign-in code for `email` was sent, read from Better Auth's verification table. */
const lastCodeAt = async (database: D1Database, email: string): Promise<number> => {
  const row = await database
    .prepare(
      'SELECT "createdAt" AS createdAt FROM "verification" WHERE "identifier" = ? ORDER BY "createdAt" DESC LIMIT 1',
    )
    .bind(`sign-in-otp-${email}`)
    .first<{ createdAt: string | number | null }>()
  return millis(row?.createdAt)
}

/**
 * Sign-in by emailed code: only the send and sign-in endpoints exist (the plugin's verify, reset and change-email
 * endpoints answer 404), only for sign-in codes. A code for an address without an account would create one, so it
 * passes the sign-up gate like any sign-up. Returns whether the path was a code path.
 */
export async function guardEmailCode(
  context: HookContext,
  env: AuthEnvironment,
  database: D1Database,
  now: number,
): Promise<boolean> {
  const path = context.path ?? ''
  if (!isCodePath(path)) return false
  const sending = path === CODE_SEND
  if (!sending && path !== CODE_SIGN_IN) throw new APIError('NOT_FOUND', { message: 'Not found' })
  if (sending && context.body?.type !== 'sign-in') throw new APIError('BAD_REQUEST', { message: 'Invalid request' })
  const email = Predicate.isString(context.body?.email) ? canonicalEmail(context.body.email) : ''
  context.body.email = email
  const known = await context.context.internalAdapter.findUserByEmail(email)
  const presented = context.headers?.get('x-invite-code') ?? ''
  let admission
  try {
    admission = await readAdmission(database, context.headers, email)
  } catch {
    if (admissionToken(context.headers) !== undefined)
      throw new APIError('FORBIDDEN', { message: 'Invitation admission required.' })
  }
  const invited = admission?.admission.state === 'active'
  if (
    known === null &&
    !invited &&
    !signupAllowed(signupMode(env.SIGNUP_MODE), env.SIGNUP_INVITE_CODE ?? '', presented)
  )
    throw new APIError('FORBIDDEN', { message: 'Sign-up is closed.' })
  if (sending && now - (await lastCodeAt(database, email)) < CODE_COOLDOWN_MS)
    throw new APIError('TOO_MANY_REQUESTS', { message: 'A code was just sent. Wait a minute before asking again.' })
  return true
}
