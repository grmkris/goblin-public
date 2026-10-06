/** Injected mail capture and D1 clocks for native fixtures only; never imported by the deployed Worker. */
import type { RuntimeEnv } from '../../src/env.ts'
import type { MailMessage } from '../../src/auth/mail.ts'

const outbox = new Map<string, MailMessage>()
export function fixtureAuth(request: Request, env: RuntimeEnv): RuntimeEnv {
  const mode = request.headers.get('x-fixture-signup')
  const operators = request.headers.get('x-fixture-operators')
  return {
    ...env,
    ...(mode === 'open' || mode === 'invite' || mode === 'closed' ? { SIGNUP_MODE: mode } : {}),
    ...(operators === null ? {} : { OPERATORS: operators }),
    SIGNUP_INVITE_CODE: 'fixture-invite',
    MAIL_SENDER: 'hello@goblin.test',
    MAIL: {
      send: (message) => {
        if (request.headers.has('x-fixture-mail-failure')) return Promise.reject(new Error('fixture mail unavailable'))
        outbox.set(message.to, message)
        return Promise.resolve(undefined)
      },
    },
  }
}
export async function authFixtureRoute(request: Request, env: RuntimeEnv): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/__test/auth/')) return undefined
  const email = url.searchParams.get('email') ?? ''
  const identifier = `sign-in-otp-${email}`
  switch (url.pathname) {
    case '/__test/auth/mail': {
      const mail = outbox.get(email)
      const row = await env.AUTH_DB.prepare('SELECT value, createdAt, expiresAt FROM verification WHERE identifier = ?')
        .bind(identifier)
        .first()
      return Response.json({ code: mail?.text.match(/code is (\d{6})/u)?.[1], row })
    }
    case '/__test/auth/expire':
      await env.AUTH_DB.prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), identifier)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/cooldown':
      await env.AUTH_DB.prepare('UPDATE verification SET createdAt = ? WHERE identifier = ?')
        .bind(new Date(Date.now() - 61_000).toISOString(), identifier)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/age-session':
      await env.AUTH_DB.prepare(
        'UPDATE session SET createdAt = ? WHERE userId IN (SELECT id FROM user WHERE email = ?)',
      )
        .bind(new Date(Date.now() - 601_000).toISOString(), email)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/accounts':
      return Response.json(
        await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM user WHERE email = ?').bind(email).first(),
      )
    default:
      return new Response(null, { status: 404 })
  }
}
