import { Predicate } from 'effect'
import { mcp } from '@better-auth/mcp'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP, jwt } from 'better-auth/plugins'
import type { RuntimeEnv } from '../env.ts'
import { deleteAgentOf } from './account.ts'
import { CODE_SEND, CODE_SIGN_IN, guardEmailCode } from './email-code.ts'
import { codeMail, mailerOf } from './mail.ts'

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
  'APP_URL' | 'BETTER_AUTH_SECRET' | 'SIGNUP_MODE' | 'SIGNUP_INVITE_CODE' | 'MAIL' | 'MAIL_SENDER' | 'AGENTS' | 'STAGE'
>

/** Per-IP limits on the endpoints that create accounts or send mail; everything else keeps the default window. */
const RATE_LIMITS = {
  '/delete-user': { window: 300, max: 5 },
  [CODE_SEND]: { window: 3600, max: 10 },
  [CODE_SIGN_IN]: { window: 300, max: 20 },
} as const

/** Six-digit sign-in codes: ten minutes, five attempts, stored hashed. Mail is required to send a code. */
type MailDelivery = { failed: boolean }
const codePlugin = (env: AuthEnvironment, delivery: MailDelivery) =>
  emailOTP({
    otpLength: 6,
    expiresIn: 600,
    allowedAttempts: 5,
    storeOTP: 'hashed',
    sendVerificationOTP: async ({ email, otp }) => {
      try {
        const mailer = mailerOf(env)
        if (mailer === undefined) {
          delivery.failed = true
          return
        }
        await mailer.binding.send(
          codeMail({
            from: mailer.from,
            to: email,
            code: otp,
            appUrl: env.APP_URL,
            ...(env.STAGE === undefined ? {} : { stage: env.STAGE }),
          }),
        )
      } catch {
        delivery.failed = true
      }
    },
  })

/** Email codes are the sole identity proof. Unsupported account methods cannot create credentials or send mail. */
const unavailableMethod = (path: string): boolean =>
  path.startsWith('/sign-up') ||
  path.startsWith('/passkey/') ||
  [
    '/sign-in/email',
    '/request-password-reset',
    '/reset-password',
    '/change-password',
    '/set-password',
    '/send-verification-email',
    '/verify-email',
    '/change-email',
  ].some((route) => path === route || path.startsWith(`${route}/`))

/** Every gate Better Auth's own options cannot express, before any endpoint runs. */
const beforeAuth = (env: AuthEnvironment, database: D1Database) =>
  createAuthMiddleware(async (context) => {
    if (context.path === '/oauth2/register') {
      markLoopbackClientsNative(context.body)
      return
    }
    if (unavailableMethod(context.path ?? '')) throw new APIError('NOT_FOUND', { message: 'Not found' })
    // Deletion requires a fresh OTP session; no token or password bypass is available.
    if (context.path?.startsWith('/delete-user')) {
      if (context.path !== '/delete-user' || context.body?.token !== undefined || context.body?.password !== undefined)
        throw new APIError('BAD_REQUEST', { message: 'Invalid request' })
      return
    }
    await guardEmailCode(context, env, database, Date.now())
  })

/**
 * Better Auth is instantiated per request: Worker I/O promises cannot outlive their request. The D1 adapter owns
 * auth tables; application Drizzle never adopts/migrates them. mcp() already includes OAuth provider functionality.
 */
const authOptions = (env: AuthEnvironment, database: D1Database) => {
  // Better Auth 1.7.6 swallows mail callback errors. Its after hook must refuse success and erase an undelivered
  // code. This state belongs to one auth instance/request, never the Worker isolate or another user's request.
  const delivery: MailDelivery = { failed: false }
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
    appName: 'goblin',
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [env.APP_URL],
    logger: { disabled: true },
    emailAndPassword: { enabled: false },
    // Deleting an account erases its agent first (conversations, MCP credentials, grants, usage); D1 then cascades
    // the user's sessions, consents and tokens. It requires a sign-in from the last 10 minutes.
    session: { freshAge: 600 },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: (user: { id: string }) => deleteAgentOf(env, user.id),
      },
    },
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 100, customRules: RATE_LIMITS },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: {
      before: beforeAuth(env, database),
      after: createAuthMiddleware(async (context) => {
        if (context.path !== CODE_SEND || !delivery.failed) return
        await context.context.internalAdapter.deleteVerificationByIdentifier(`sign-in-otp-${context.body.email}`)
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'Could not send a sign-in code. Try again.' })
      }),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: authIssuer(env.APP_URL), audience: resource } }),
      // SAFETY: Better Auth 1.7.6 MCP endpoint metadata types violate exactOptionalPropertyTypes; runtime shape is the pinned official plugin.
      oauthPlugin as BetterAuthPlugin,
      codePlugin(env, delivery),
    ],
  }
}
export const createAuth = (env: AuthEnvironment, database: D1Database) => betterAuth(authOptions(env, database))
