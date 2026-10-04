import { Predicate } from 'effect'
import { mcp } from '@better-auth/mcp'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP, jwt } from 'better-auth/plugins'
import type { RuntimeEnv } from '../env.ts'
import { deleteAgentOf } from './account.ts'
import { CODE_SEND, CODE_SIGN_IN, guardEmailCode } from './email-code.ts'
import { codeMail, mailerOf, resetMail, verificationMail } from './mail.ts'
import { canonicalEmail, signupAllowed, signupMode } from './signup.ts'
import { passwordHasher } from './password.ts'

const AUTH_BASE_PATH = '/api/auth'
const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
export const mcpResource = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}/mcp`
export const authIssuer = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}${AUTH_BASE_PATH}`

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const isLoopbackHttp = (uri: unknown): boolean => {
  if (!Predicate.isString(uri)) return false
  try {
    const url = new URL(uri)
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * MCP clients (Claude Code and others) register http loopback redirects without saying `application_type`, and the
 * provider defaults that to `web`, which forbids them. A registration whose every redirect is http loopback is a
 * native app by RFC 8252; say so. Anything else keeps the provider's rules.
 */
export const markLoopbackClientsNative = (body: unknown): void => {
  if (!Predicate.isObject(body) || 'application_type' in body) return
  const uris = 'redirect_uris' in body ? body.redirect_uris : undefined
  if (Array.isArray(uris) && uris.length > 0 && uris.every(isLoopbackHttp))
    Object.assign(body, { application_type: 'native' })
}

export type AuthEnvironment = Pick<
  RuntimeEnv,
  'APP_URL' | 'BETTER_AUTH_SECRET' | 'SIGNUP_MODE' | 'SIGNUP_INVITE_CODE' | 'MAIL' | 'MAIL_SENDER' | 'AGENTS'
>

/** Per-IP limits on the endpoints that create accounts or send mail; everything else keeps the default window. */
const RATE_LIMITS = {
  '/sign-up/email': { window: 3600, max: 10 },
  '/send-verification-email': { window: 3600, max: 5 },
  '/sign-in/email': { window: 300, max: 20 },
  '/delete-user': { window: 300, max: 5 },
  '/request-password-reset': { window: 3600, max: 5 },
  '/reset-password': { window: 300, max: 10 },
  [CODE_SEND]: { window: 3600, max: 10 },
  [CODE_SIGN_IN]: { window: 300, max: 20 },
} as const
type Mail = ReturnType<typeof mailerOf>

/**
 * Password accounts, and with a mail sender: confirmation before an account works (the link signs the user in) and
 * reset links that sign every device out. Without a sender there is no mail, so neither exists.
 */
const accountEmailOptions = (env: AuthEnvironment, mailer: Mail) => {
  const base = { enabled: true, minPasswordLength: 12, maxPasswordLength: 256, password: passwordHasher }
  if (mailer === undefined) return { emailAndPassword: { ...base, requireEmailVerification: false } }
  const send =
    (build: typeof verificationMail) =>
    async ({ user, url }: { user: { email: string }; url: string }) => {
      await mailer.binding.send(build({ from: mailer.from, to: user.email, url, appUrl: env.APP_URL }))
    }
  return {
    emailAndPassword: {
      ...base,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: send(resetMail),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 3600,
      sendVerificationEmail: send(verificationMail),
    },
  }
}

/** Sign-in by a six-digit emailed code (ten minutes, five tries, stored hashed), when the deployment sends mail. */
const codePlugins = (env: AuthEnvironment, mailer: Mail): BetterAuthPlugin[] =>
  mailer === undefined
    ? []
    : [
        emailOTP({
          otpLength: 6,
          expiresIn: 600,
          allowedAttempts: 5,
          storeOTP: 'hashed',
          sendVerificationOTP: async ({ email, otp, type }) => {
            if (type === 'sign-in')
              await mailer.binding.send(codeMail({ from: mailer.from, to: email, code: otp, appUrl: env.APP_URL }))
          },
        }),
      ]

/** Every gate Better Auth's own options cannot express, before any endpoint runs. */
const beforeAuth = (env: AuthEnvironment, database: D1Database) =>
  createAuthMiddleware(async (context) => {
    if (context.path === '/oauth2/register') {
      markLoopbackClientsNative(context.body)
      return
    }
    // Deleting needs the password, or a sign-in within the last 10 minutes (`freshAge`), the only proof a code-only
    // account can give. The emailed-token path is never offered.
    if (context.path?.startsWith('/delete-user')) {
      if (context.path !== '/delete-user' || context.body?.token !== undefined)
        throw new APIError('BAD_REQUEST', { message: 'Invalid request' })
      return
    }
    if (await guardEmailCode(context, env, database, Date.now())) return
    if (!context.path?.startsWith('/sign-up')) return
    const presented = context.headers?.get('x-invite-code') ?? ''
    if (
      context.path !== '/sign-up/email' ||
      !signupAllowed(signupMode(env.SIGNUP_MODE), env.SIGNUP_INVITE_CODE ?? '', presented)
    )
      throw new APIError('FORBIDDEN', { message: 'Sign-up is closed.' })
    if (Predicate.isString(context.body?.email)) context.body.email = canonicalEmail(context.body.email)
  })

/**
 * Better Auth is instantiated per request: Worker I/O promises cannot outlive their request. The D1 adapter owns
 * auth tables; application Drizzle never adopts/migrates them. mcp() already includes OAuth provider functionality.
 */
const authOptions = (env: AuthEnvironment, database: D1Database) => {
  const resource = mcpResource(env.APP_URL)
  const oauthPlugin = mcp({
    resource,
    scopes: [...MCP_SCOPES],
    loginPage: '/login',
    consentPage: '/consent',
    // MCP clients (Claude Code and others) register themselves before the owner signs in. Registration grants
    // nothing: every new client needs the owner's consent, and only the /mcp resource can be requested.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationAllowedResources: [resource],
    clientRegistrationDefaultScopes: [...MCP_SCOPES],
  })
  return {
    appName: 'purrable',
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [env.APP_URL],
    logger: { disabled: true },
    ...accountEmailOptions(env, mailerOf(env)),
    // Deleting an account erases its agent first (conversations, MCP credentials, grants, usage); D1 then cascades
    // the user's sessions, consents and tokens. Without the password it needs a sign-in from the last 10 minutes.
    session: { freshAge: 600 },
    user: { deleteUser: { enabled: true, beforeDelete: (user: { id: string }) => deleteAgentOf(env, user.id) } },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 100, customRules: RATE_LIMITS },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: { before: beforeAuth(env, database) },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: authIssuer(env.APP_URL), audience: resource } }),
      // SAFETY: Better Auth 1.7.6 MCP endpoint metadata types violate exactOptionalPropertyTypes; runtime shape is the pinned official plugin.
      oauthPlugin as BetterAuthPlugin,
      ...codePlugins(env, mailerOf(env)),
    ],
  }
}
export const createAuth = (env: AuthEnvironment, database: D1Database) => betterAuth(authOptions(env, database))
