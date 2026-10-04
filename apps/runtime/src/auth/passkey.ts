import { passkey } from '@better-auth/passkey'
import { APIError } from 'better-auth/api'

/**
 * Passkeys as the myapps apps run them (grmkris/myapps packages/auth/src/methods.ts): the relying party is Purrable's
 * own host and origin (never the request's Origin header), credentials are discoverable (sign in without typing an
 * email), and the authenticator must verify the person, which is checked after verification as well as asked for.
 * Adding one needs a sign-in from the last 10 minutes (`freshAge`); a passkey never creates an account.
 */
export const passkeyPlugin = (appUrl: string) =>
  passkey({
    rpID: new URL(appUrl).hostname,
    rpName: 'Purrable',
    origin: appUrl.replace(/\/$/u, ''),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    authentication: {
      afterVerification: ({ verification }) => {
        if (!verification.authenticationInfo.userVerified)
          throw new APIError('UNAUTHORIZED', { message: 'The passkey did not verify the user' })
      },
    },
  })
