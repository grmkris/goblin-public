import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/client'
import { isString, record } from './boundary.ts'

/**
 * Better Auth in the browser. The OAuth provider plugin adds the signed authorization query to sign-in and consent
 * calls made from /login and /consent, so an MCP client's authorization resumes after the owner signs in.
 */
export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [oauthProviderClient()] })

/** Where an OAuth step wants the browser to go next, if anywhere. */
export const redirectOf = (data: unknown): string | undefined => {
  const value = record(data)
  const target = value?.redirect_uri ?? value?.url
  return isString(target) ? target : undefined
}
