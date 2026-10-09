import { mutationOptions, queryOptions } from '@tanstack/react-query'
import { Data, Option, Schema } from 'effect'
import { authClient, redirectOf } from '../lib/auth-client.ts'

/**
 * Signing in and what is public about the deployment: Better Auth's own routes (through `authClient`) and the Worker's
 * `/health`, which keep their protocols outside the owner API. Keys are `[feature, kind, input]`.
 */

/** Better Auth answered with a refusal; `status` is the HTTP status, which `describeError` classifies. */
export class AuthRefused extends Data.TaggedError('AuthRefused')<{ readonly status: number }> {}

/** A Better Auth answer's data, or its refusal thrown. */
const settled = <A>({ data, error }: { readonly data: A; readonly error: { readonly status: number } | null }): A => {
  if (error !== null) throw new AuthRefused({ status: error.status })
  return data
}

/** Whether someone is signed in. Better Auth answers a visitor without a session with null, which is not a failure. */
export const sessionQuery = queryOptions({
  queryKey: ['auth', 'session'],
  queryFn: async ({ signal }): Promise<'signed-in' | 'signed-out'> => {
    const session = settled(await authClient.getSession({ fetchOptions: { signal } }))
    return session === null ? 'signed-out' : 'signed-in'
  },
  meta: { auth: 'optional' },
})

const Health = Schema.Struct({
  signup: Schema.optional(Schema.Literals(['open', 'invite', 'closed'])),
  mail: Schema.optional(Schema.Boolean),
})
const decodeHealth = Schema.decodeUnknownOption(Health)

/** How sign-up works here and whether sign-in mail is on; anything the Worker does not say reads as off. */
export const healthQuery = queryOptions({
  queryKey: ['auth', 'health'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/health', { signal })
    if (!response.ok) throw new AuthRefused({ status: response.status })
    const health = Option.getOrElse(decodeHealth(await response.json()), (): typeof Health.Type => ({}))
    return { signup: health.signup ?? 'closed', mail: health.mail === true }
  },
  meta: { auth: 'optional' },
})

const ClientClaims = Schema.Struct({
  client_name: Schema.optional(Schema.String),
  client_uri: Schema.optional(Schema.String),
})
const decodeClient = Schema.decodeUnknownOption(ClientClaims)

/** The name and address an OAuth client registered: its own claims, unverified. */
export const consentClientQuery = (clientId: string) =>
  queryOptions({
    queryKey: ['auth', 'client', clientId],
    queryFn: async ({ signal }) => {
      const data = settled(
        await authClient.$fetch('/oauth2/public-client', {
          method: 'GET',
          query: { client_id: clientId },
          signal,
        }),
      )
      const claims = decodeClient(data)
      if (Option.isNone(claims)) throw new AuthRefused({ status: 502 })
      const { client_name: name, client_uri: uri } = claims.value
      return { name: name ?? 'Unnamed client', ...(uri === undefined ? {} : { uri }) }
    },
  })

/** The owner's answer to a client's request; where Better Auth sends the browser next. */
export const consentMutation = mutationOptions({
  mutationFn: async (body: Record<string, unknown>) => {
    const next = redirectOf(settled(await authClient.$fetch('/oauth2/consent', { method: 'POST', body })))
    if (next === undefined) throw new AuthRefused({ status: 502 })
    return next
  },
})

/** Ends the session; a refusal leaves the session as it is. */
export const signOutMutation = mutationOptions({
  mutationFn: async (_: void) => {
    settled(await authClient.signOut())
  },
})

/** Deletes the account; Better Auth asks for a sign-in within the last few minutes first. */
export const deleteAccountMutation = mutationOptions({
  mutationFn: async (_: void) => {
    settled(await authClient.deleteUser())
  },
})
