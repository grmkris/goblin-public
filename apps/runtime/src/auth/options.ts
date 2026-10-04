import { Predicate } from 'effect'
import { mcp } from '@better-auth/mcp'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { constantTimeEqual, generateRandomString } from 'better-auth/crypto'
import { jwt } from 'better-auth/plugins'
import type { RuntimeEnv } from '../env.ts'
import { passwordHasher } from './password.ts'

const AUTH_BASE_PATH = '/api/auth'
const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
export const mcpResource = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}/mcp`
export const authIssuer = (appUrl: string): string => `${appUrl.replace(/\/$/u, '')}${AUTH_BASE_PATH}`
export const canonicalEmail = (email: string): string => email.trim().toLowerCase()

export type AuthEnvironment = Pick<
  RuntimeEnv,
  'APP_URL' | 'BETTER_AUTH_SECRET' | 'OWNER_EMAIL' | 'OWNER_BOOTSTRAP_TOKEN' | 'STAGE'
>
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
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 256, password: passwordHasher },
    advanced: {
      database: {
        generateId: ({ model }: { model: string }) =>
          model === 'user' ? 'owner' : generateRandomString(32, 'a-z', 'A-Z', '0-9'),
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!context.path?.startsWith('/sign-up')) return
        const email = Predicate.isString(context.body?.email) ? canonicalEmail(context.body.email) : ''
        const presented = context.headers?.get('x-owner-bootstrap') ?? ''
        if (
          context.path !== '/sign-up/email' ||
          (env.STAGE !== 'dev' && env.STAGE !== 'local' && env.STAGE !== 'test') ||
          !env.OWNER_BOOTSTRAP_TOKEN ||
          !constantTimeEqual(presented, env.OWNER_BOOTSTRAP_TOKEN) ||
          !env.OWNER_EMAIL ||
          email !== canonicalEmail(env.OWNER_EMAIL)
        )
          throw new APIError('FORBIDDEN', { message: 'Owner registration is closed.' })
        context.body.email = email
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            const count = await database.prepare('SELECT COUNT(*) AS count FROM "user"').first<{ count: number }>()
            if (
              !env.OWNER_EMAIL ||
              canonicalEmail(user.email) !== canonicalEmail(env.OWNER_EMAIL) ||
              count?.count !== 0
            )
              return false
            return undefined
          },
        },
      },
      session: {
        create: { before: async (session: { userId: string }) => (session.userId === 'owner' ? undefined : false) },
      },
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: authIssuer(env.APP_URL), audience: resource } }),
      // SAFETY: Better Auth 1.7.6 MCP endpoint metadata types violate exactOptionalPropertyTypes; runtime shape is the pinned official plugin.
      oauthPlugin as BetterAuthPlugin,
    ],
  }
}
export const createAuth = (env: AuthEnvironment, database: D1Database) => betterAuth(authOptions(env, database))
