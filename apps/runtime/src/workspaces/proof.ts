import { and, eq, gt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Forbidden, NotFound, RateLimited } from '../http/errors.ts'
import { admissions, invitations, rateLimits, workspaces } from './schema.ts'
import { databaseOperation } from './store.ts'

export const ADMISSION_COOKIE = '__Host-purrable-invite'
export const hash = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export const secret = (bytes = 32): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export const admissionToken = (headers: Headers | undefined): string | undefined =>
  headers
    ?.get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMISSION_COOKIE}=`))
    ?.slice(ADMISSION_COOKIE.length + 1)
export const admissionCookie = (token: string, maxAge = 600): string =>
  `${ADMISSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`

/** Fixed one-minute buckets, persisted atomically in auth D1. Count rejected guesses too. */
export async function limitProof(database: D1Database, key: string, maximum: number, windowMs = 60_000): Promise<void> {
  const db = drizzle(database)
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const row = await databaseOperation(() =>
    db
      .insert(rateLimits)
      .values({ key, windowStart, attempts: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          windowStart,
          attempts: sql`CASE WHEN ${rateLimits.windowStart} = ${windowStart} THEN ${rateLimits.attempts} + 1 ELSE 1 END`,
        },
      })
      .returning()
      .get(),
  )
  if (row.attempts > maximum) throw new RateLimited({ reason: 'invitation proof attempts' })
}

/** Reads current invitation/workspace version on every OTP send, verification and acceptance. */
export async function readAdmission(database: D1Database, headers: Headers | undefined, email?: string) {
  const token = admissionToken(headers)
  if (token === undefined) return undefined
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Forbidden({ reason: 'invitation admission' })
  const proofHash = await hash(token)
  const db = drizzle(database)
  const row = await databaseOperation(() =>
    db
      .select({ admission: admissions, invitation: invitations, workspace: workspaces })
      .from(admissions)
      .innerJoin(invitations, eq(admissions.invitationId, invitations.id))
      .innerJoin(workspaces, eq(invitations.workspaceId, workspaces.id))
      .where(
        and(eq(admissions.proofHash, proofHash), gt(admissions.expiresAt, Date.now()), eq(workspaces.state, 'active')),
      )
      .get(),
  )
  if (row === undefined || row.admission.state === 'revoked' || row.invitation.expiresAt <= Date.now())
    throw new NotFound({ what: 'invitation' })
  const pending =
    row.admission.state === 'active' &&
    row.invitation.state === 'pending' &&
    row.admission.invitationVersion === row.invitation.version
  const accepted =
    row.admission.state === 'used' &&
    row.invitation.state === 'accepted' &&
    row.admission.invitationVersion + 1 === row.invitation.version
  if ((!pending && !accepted) || (email !== undefined && row.admission.email !== email.trim().toLowerCase()))
    throw new Forbidden({ reason: 'invitation admission' })
  return row
}
