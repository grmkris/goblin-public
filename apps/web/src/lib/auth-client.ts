import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient } from 'better-auth/client/plugins'
import { isString, record } from './boundary.ts'

/**
 * Better Auth in the browser: emailed codes and the OAuth provider plugin, which adds the signed
 * authorization query to sign-in and consent calls made from /login and /consent, so an MCP client's authorization
 * resumes after the owner signs in with an emailed code.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [oauthProviderClient(), emailOTPClient()],
})

/** Where an OAuth step wants the browser to go next, if anywhere. */
export const redirectOf = (data: unknown): string | undefined => {
  const value = record(data)
  const target = value?.redirect_uri ?? value?.url
  return isString(target) ? target : undefined
}
