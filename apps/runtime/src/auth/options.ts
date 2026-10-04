import { Predicate } from 'effect'
import { mcp } from '@better-auth/mcp'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { constantTimeEqual } from 'better-auth/crypto'
import { jwt } from 'better-auth/plugins'
import type { RuntimeEnv } from '../env.ts'
import { mailerOf, verificationMail } from './mail.ts'
import { passwordHasher } from './password.ts'

const AUTH_BASE_PATH = '/api/auth'
const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
export const mcpResource = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}/mcp`
export const authIssuer = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}${AUTH_BASE_PATH}`
export const canonicalEmail = (email: string): string => email.trim().toLowerCase()

export type SignupMode = 'open' | 'invite' | 'closed'
export const signupMode = (value: string | undefined): SignupMode =>
  value === 'open' || value === 'invite' ? value : 'closed'

/** Open lets anyone register; invite needs the configured code; closed (the default) refuses every sign-up. */
export const signupAllowed = (mode: SignupMode, inviteCode: string, presented: string): boolean =>
  mode === 'open' || (mode === 'invite' && inviteCode.length > 0 && constantTimeEqual(presented, inviteCode))

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
  'APP_URL' | 'BETTER_AUTH_SECRET' | 'SIGNUP_MODE' | 'SIGNUP_INVITE_CODE' | 'MAIL' | 'MAIL_SENDER'
>

/** Per-IP limits on the endpoints that create accounts or send mail; everything else keeps the default window. */
const RATE_LIMITS = {
  '/sign-up/email': { window: 3600, max: 10 },
  '/send-verification-email': { window: 3600, max: 5 },
  '/sign-in/email': { window: 300, max: 20 },
} as const
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
  const mailer = mailerOf(env)
  return {
    appName: 'purrable',
    baseURL: env.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [env.APP_URL],
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: passwordHasher,
      // With a mail sender, an account works only after its owner opens the link sent to the address.
      requireEmailVerification: mailer !== undefined,
    },
    ...(mailer === undefined
      ? {}
      : {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            expiresIn: 3600,
            sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
              await mailer.binding.send(
                verificationMail({ from: mailer.from, to: user.email, url, appUrl: env.APP_URL }),
              )
            },
          },
        }),
    rateLimit: { enabled: true, storage: 'database' as const, window: 60, max: 100, customRules: RATE_LIMITS },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === '/oauth2/register') {
          markLoopbackClientsNative(context.body)
          return
        }
        if (!context.path?.startsWith('/sign-up')) return
        const presented = context.headers?.get('x-invite-code') ?? ''
        if (
          context.path !== '/sign-up/email' ||
          !signupAllowed(signupMode(env.SIGNUP_MODE), env.SIGNUP_INVITE_CODE ?? '', presented)
        )
          throw new APIError('FORBIDDEN', { message: 'Sign-up is closed.' })
        if (Predicate.isString(context.body?.email)) context.body.email = canonicalEmail(context.body.email)
      }),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: authIssuer(env.APP_URL), audience: resource } }),
      // SAFETY: Better Auth 1.7.6 MCP endpoint metadata types violate exactOptionalPropertyTypes; runtime shape is the pinned official plugin.
      oauthPlugin as BetterAuthPlugin,
    ],
  }
}
export const createAuth = (env: AuthEnvironment, database: D1Database) => betterAuth(authOptions(env, database))
