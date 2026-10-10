import { mutationOptions, queryOptions } from '@tanstack/react-query'
import { Data, Option, Schema } from 'effect'
import { requestId } from '../lib/api.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { answerRef } from '../lib/query/app-error.ts'

/**
 * Signing in and out and what is public about the deployment: Better Auth's own routes (through `authClient`) and the
 * Worker's `/health`, which keep their protocols outside the owner API. Keys are `['auth', kind, input]`. Every call
 * sends its own `x-goblin-request` id, so a failure quotes the reference its answer carried, or that id when nothing
 * answered.
 */

/**
 * Better Auth or `/health` refused (`status`, which `describeError` classifies), or nothing answered (503). `ref` is
 * what the owner quotes (`answerRef`, else the request's own id); `messageOf` and `withRef` end with it.
 */
export class AuthRefused extends Data.TaggedError('AuthRefused')<{ readonly status: number; readonly ref: string }> {}

/** The reference `response` carries for the owner to quote. */
const refOf = (response: Response): string | undefined => answerRef((name) => response.headers.get(name))

/** The fetch options every Better Auth call here carries: its request id, and a hook that keeps its answer's ref. */
type AuthFetch = {
  readonly headers: Readonly<Record<string, string>>
  readonly onResponse: (context: { readonly response: Response }) => void
  readonly signal?: AbortSignal
}
type AuthAnswer<A> = { readonly data: A; readonly error: { readonly status: number } | null }

/**
 * Runs one Better Auth call: its data with the reference its answer quotes, or its refusal (or silence) as an
 * AuthRefused with that reference.
 */
async function authCall<A>(
  call: (fetchOptions: AuthFetch) => Promise<AuthAnswer<A>>,
  options: { readonly signal?: AbortSignal; readonly headers?: Readonly<Record<string, string>> } = {},
): Promise<{ readonly data: A; readonly ref: string }> {
  const sent = requestId()
  let ref: string | undefined
  const fetchOptions: AuthFetch = {
    headers: { ...options.headers, 'x-goblin-request': sent },
    onResponse: ({ response }) => {
      ref = refOf(response)
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  let answer: AuthAnswer<A>
  try {
    answer = await call(fetchOptions)
  } catch {
    throw new AuthRefused({ status: 503, ref: sent })
  }
  if (answer.error !== null) throw new AuthRefused({ status: answer.error.status, ref: ref ?? sent })
  return { data: answer.data, ref: ref ?? sent }
}

/** Whether someone is signed in. Better Auth answers a visitor without a session with null, which is not a failure. */
export const sessionQuery = queryOptions({
  queryKey: ['auth', 'session'],
  queryFn: async ({ signal }): Promise<'signed-in' | 'signed-out'> => {
    const { data: session } = await authCall((fetchOptions) => authClient.getSession({ fetchOptions }), { signal })
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
    const sent = requestId()
    let response: Response
    try {
      response = await fetch('/health', { headers: { 'x-goblin-request': sent }, signal })
    } catch {
      throw new AuthRefused({ status: 503, ref: sent })
    }
    if (!response.ok) throw new AuthRefused({ status: response.status, ref: refOf(response) ?? sent })
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
      const { data, ref } = await authCall(
        (fetchOptions) =>
          authClient.$fetch('/oauth2/public-client', {
            method: 'GET',
            query: { client_id: clientId },
            ...fetchOptions,
          }),
        { signal },
      )
      const claims = decodeClient(data)
      if (Option.isNone(claims)) throw new AuthRefused({ status: 502, ref })
      const { client_name: name, client_uri: uri } = claims.value
      return { name: name ?? 'Unnamed client', ...(uri === undefined ? {} : { uri }) }
    },
  })

/** The owner's answer to a client's request; where Better Auth sends the browser next. */
export const consentMutation = mutationOptions({
  mutationFn: async (body: Record<string, unknown>) => {
    const { data, ref } = await authCall((fetchOptions) =>
      authClient.$fetch('/oauth2/consent', { method: 'POST', body, ...fetchOptions }),
    )
    const next = redirectOf(data)
    if (next === undefined) throw new AuthRefused({ status: 502, ref })
    return next
  },
})

/**
 * Ends the session. Its caller leaves for the start page either way, which shows the outcome: still signed in there if
 * the server kept the session, so an expired one is no reason to send anyone to sign in first.
 */
export const signOutMutation = mutationOptions({
  mutationFn: async (_: void) => {
    await authCall((fetchOptions) => authClient.signOut({ fetchOptions }))
  },
  meta: { auth: 'optional' },
})

/** Deletes the account; Better Auth asks for a sign-in within the last few minutes first. */
export const deleteAccountMutation = mutationOptions({
  mutationFn: async (_: void) => {
    await authCall((fetchOptions) => authClient.deleteUser({ fetchOptions }))
  },
})

/** Emails a sign-in code; with an invite code, a new account may be made with it. */
export const requestSignInCode = async (email: string, inviteCode: string): Promise<void> => {
  await authCall(
    (fetchOptions) => authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions }),
    inviteCode === '' ? {} : { headers: { 'x-invite-code': inviteCode } },
  )
}

/** Signs in with an emailed code; the answer may name where an OAuth authorization continues. */
export const verifySignInCode = async (email: string, otp: string, inviteCode: string): Promise<unknown> => {
  const { data } = await authCall(
    (fetchOptions) => authClient.signIn.emailOtp({ email, otp, fetchOptions }),
    inviteCode === '' ? {} : { headers: { 'x-invite-code': inviteCode } },
  )
  return data
}
