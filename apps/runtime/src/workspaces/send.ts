import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { RuntimeEnv } from '../env.ts'
import { invitationMail, mailerOf } from '../auth/mail.ts'
import { invitations } from './schema.ts'
import { databaseOperation } from './store.ts'

/** Store first, send outside D1, then record delivery attempt. Recovery never automatically sends again. */
export async function sendInvitation(
  env: RuntimeEnv,
  invite: typeof invitations.$inferSelect,
  fragment: string,
  code: string,
) {
  const mailer = mailerOf(env)
  let sendState: 'sent' | 'failed' = 'failed'
  if (mailer !== undefined) {
    try {
      await mailer.binding.send(
        invitationMail({
          from: mailer.from,
          to: invite.email,
          url: `${env.APP_URL}/invite/${invite.id}#${fragment}`,
          code,
          appUrl: env.APP_URL,
          ...(env.STAGE === undefined ? {} : { stage: env.STAGE }),
        }),
      )
      sendState = 'sent'
    } catch {
      /* the owner can rotate and resend; no automatic duplicate effect */
    }
  }
  const db = drizzle(env.AUTH_DB)
  await databaseOperation(() =>
    db
      .update(invitations)
      .set({ sendState, updatedAt: Date.now() })
      .where(
        and(eq(invitations.id, invite.id), eq(invitations.version, invite.version), eq(invitations.state, 'pending')),
      )
      .run(),
  )
  return sendState
}
