/**
 * Who calls the owner API. A Privy access token (ES256, verified here against the app's JWKS) names the Privy user;
 * Privy's user API then names that user's embedded EVM wallet at wallet index 0, the owner wallet. The agent wallet
 * the owner owns appears in the same list at a higher index and is never taken for the owner.
 */
import type { Address } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export interface OwnerIdentity {
  /** Privy's user id, `did:privy:…`. Encode it before it goes into a URL. */
  readonly userId: string
  /** The owner's embedded EVM wallet. */
  readonly ownerAddress: Address
}

/**
 * Why a request has no owner. `privy_unavailable` is ours and worth a retry; `no_owner_wallet` means the user signed
 * in but Privy has not created their embedded wallet yet; the rest mean "sign in again".
 */
export type IdentityRefusal = 'missing_token' | 'invalid_token' | 'no_owner_wallet' | 'privy_unavailable'

export type IdentityResult =
  | { readonly ok: true; readonly owner: OwnerIdentity }
  | { readonly ok: false; readonly reason: IdentityRefusal }

/** The HTTP status a refusal answers with. */
export const refusalStatus = (reason: IdentityRefusal): 401 | 409 | 503 =>
  reason === 'privy_unavailable' ? 503 : reason === 'no_owner_wallet' ? 409 : 401

export interface IdentityOptions {
  readonly appId: string
  readonly appSecret: string
  /** Injected in tests; the platform `fetch` otherwise. */
  readonly fetch?: typeof fetch
  /** Epoch milliseconds; `Date.now` otherwise. */
  readonly now?: () => number
}

export interface IdentityVerifier {
  /** Reads `authorization: Bearer <Privy access token>` and resolves the owner. */
  verifyRequest(request: Request): Promise<IdentityResult>
  verifyToken(token: string): Promise<IdentityResult>
}

const JWKS_TTL_MS = 10 * 60_000
/** An unknown `kid` refetches the key set, at most this often (Privy rotating its key). */
const JWKS_REFETCH_MS = 30_000
const OWNER_TTL_MS = 10 * 60_000
const CLOCK_SKEW_S = 30
const PRIVY_TIMEOUT_MS = 10_000

const Header = Schema.Struct({ alg: Schema.Literal('ES256'), kid: Schema.optional(Schema.String) })
const Claims = Schema.Struct({
  iss: Schema.Literal('privy.io'),
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  sub: Schema.String.check(Schema.isPattern(/^did:privy:[A-Za-z0-9]{1,64}$/u)),
  exp: Schema.Finite,
  nbf: Schema.optional(Schema.Finite),
  iat: Schema.optional(Schema.Finite),
})
type Claims = typeof Claims.Type
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

const Jwk = Schema.Struct({
  kty: Schema.String,
  crv: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
  x: Schema.optional(Schema.String),
  y: Schema.optional(Schema.String),
})
type Jwk = typeof Jwk.Type
const decodeJwks = Schema.decodeUnknownOption(Schema.Struct({ keys: Schema.Array(Jwk) }))

const LinkedAccount = Schema.Struct({
  type: Schema.String,
  address: Schema.optional(Schema.String),
  chain_type: Schema.optional(Schema.String),
  wallet_client_type: Schema.optional(Schema.String),
  connector_type: Schema.optional(Schema.String),
  wallet_index: Schema.optional(Schema.NullOr(Schema.Finite)),
})
type LinkedAccount = typeof LinkedAccount.Type
const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String, linked_accounts: Schema.Array(LinkedAccount) }),
)

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return undefined
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** The owner wallet: Privy's embedded EVM wallet at index 0 (index null on accounts made before indexes). */
export const ownerWallet = (accounts: readonly LinkedAccount[]): Address | undefined =>
  accounts.find(
    (account) =>
      account.type === 'wallet' &&
      account.chain_type === 'ethereum' &&
      account.wallet_client_type === 'privy' &&
      (account.connector_type === undefined || account.connector_type === 'embedded') &&
      (account.wallet_index === undefined || account.wallet_index === null || account.wallet_index === 0) &&
      account.address !== undefined &&
      EVM_ADDRESS.test(account.address),
  )?.address

const audienceIncludes = (aud: Claims['aud'], appId: string): boolean =>
  typeof aud === 'string' ? aud === appId : aud.includes(appId)

/** The claims are current: not expired, not from the future beyond a small skew. */
const current = (claims: Claims, nowS: number): boolean =>
  claims.exp > nowS &&
  (claims.nbf === undefined || claims.nbf <= nowS + CLOCK_SKEW_S) &&
  (claims.iat === undefined || claims.iat <= nowS + CLOCK_SKEW_S)

interface ParsedToken {
  readonly kid: string | undefined
  readonly claims: Claims
  readonly signed: Uint8Array
  readonly signature: Uint8Array
}

/** Splits and decodes a compact JWS; undefined when any part is malformed. Verifies nothing yet. */
export const parseToken = (token: string): ParsedToken | undefined => {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [headerPart = '', claimsPart = '', signaturePart = ''] = parts
  try {
    const header = fromBase64Url(headerPart)
    const body = fromBase64Url(claimsPart)
    const signature = fromBase64Url(signaturePart)
    if (header === undefined || body === undefined || signature?.length !== 64) return undefined
    const decodedHeader = Option.getOrUndefined(decodeHeader(text(header)))
    const claims = Option.getOrUndefined(decodeClaims(text(body)))
    if (decodedHeader === undefined || claims === undefined) return undefined
    return {
      kid: decodedHeader.kid,
      claims,
      signed: new TextEncoder().encode(`${headerPart}.${claimsPart}`),
      signature,
    }
  } catch {
    // expected: atob rejects a malformed segment; a malformed token is simply not a token.
    return undefined
  }
}

interface KeySet {
  readonly keys: readonly Jwk[]
  readonly fetchedAt: number
}

/** Privy's answer about a user: their owner wallet, no such user or wallet, or no answer. */
type OwnerLookup = { readonly found: Address } | 'missing' | 'unavailable'

const refuse = (reason: IdentityRefusal): IdentityResult => ({ ok: false, reason })

/**
 * A verifier with its own caches: the app's key set (ten minutes, refetched early for an unknown `kid`) and each
 * user's owner wallet (ten minutes; an embedded wallet's address never changes).
 */
export class PrivyIdentity implements IdentityVerifier {
  readonly #options: IdentityOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #keySet: KeySet | undefined
  readonly #owners = new Map<string, { readonly address: Address; readonly until: number }>()

  constructor(options: IdentityOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#now = options.now ?? Date.now
  }

  verifyRequest(request: Request): Promise<IdentityResult> {
    const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/u.exec(request.headers.get('authorization') ?? '')
    const token = match?.[1]
    return token === undefined ? Promise.resolve(refuse('missing_token')) : this.verifyToken(token)
  }

  async verifyToken(token: string): Promise<IdentityResult> {
    if (this.#options.appId === '' || this.#options.appSecret === '') return refuse('privy_unavailable')
    const parsed = parseToken(token)
    const nowS = Math.floor(this.#now() / 1000)
    if (
      parsed === undefined ||
      !audienceIncludes(parsed.claims.aud, this.#options.appId) ||
      !current(parsed.claims, nowS)
    )
      return refuse('invalid_token')
    try {
      const jwk = await this.#keyFor(parsed.kid)
      if (jwk === 'unavailable') return refuse('privy_unavailable')
      if (jwk === undefined || !(await verifySignature(jwk, parsed))) return refuse('invalid_token')
      const owner = await this.#loadOwner(parsed.claims.sub)
      if (owner === 'unavailable') return refuse('privy_unavailable')
      if (owner === 'missing') return refuse('no_owner_wallet')
      return { ok: true, owner: { userId: parsed.claims.sub, ownerAddress: owner.found } }
    } catch {
      // expected: a network failure, a timeout or a non-JSON body from Privy; the caller may retry.
      return refuse('privy_unavailable')
    }
  }

  async #fetchKeys(): Promise<KeySet | 'unavailable'> {
    const url = `https://auth.privy.io/api/v1/apps/${encodeURIComponent(this.#options.appId)}/jwks.json`
    const response = await this.#fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PRIVY_TIMEOUT_MS) })
    if (!response.ok) return 'unavailable'
    const decoded = Option.getOrUndefined(decodeJwks(await response.json()))
    if (decoded === undefined) return 'unavailable'
    this.#keySet = { keys: decoded.keys, fetchedAt: this.#now() }
    return this.#keySet
  }

  async #keyFor(kid: string | undefined): Promise<Jwk | undefined | 'unavailable'> {
    const pick = (set: KeySet) =>
      set.keys.find((key) => key.kty === 'EC' && key.crv === 'P-256' && (kid === undefined || key.kid === kid))
    const age = this.#keySet === undefined ? Infinity : this.#now() - this.#keySet.fetchedAt
    const hit = this.#keySet !== undefined && age < JWKS_TTL_MS ? pick(this.#keySet) : undefined
    if (hit !== undefined) return hit
    if (age < JWKS_REFETCH_MS) return undefined
    const fresh = await this.#fetchKeys()
    return fresh === 'unavailable' ? fresh : pick(fresh)
  }

  async #loadOwner(userId: string): Promise<OwnerLookup> {
    const cached = this.#owners.get(userId)
    if (cached !== undefined && cached.until > this.#now()) return { found: cached.address }
    const { appId, appSecret } = this.#options
    const response = await this.#fetch(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, 'privy-app-id': appId },
      redirect: 'manual',
      signal: AbortSignal.timeout(PRIVY_TIMEOUT_MS),
    })
    if (response.status === 404) return 'missing'
    if (!response.ok) return 'unavailable'
    const user = Option.getOrUndefined(decodeUser(await response.json()))
    if (user === undefined) return 'unavailable'
    const address = user.id === userId ? ownerWallet(user.linked_accounts) : undefined
    if (address === undefined) return 'missing'
    this.#owners.set(userId, { address, until: this.#now() + OWNER_TTL_MS })
    return { found: address }
  }
}

const verifySignature = async (jwk: Jwk, parsed: ParsedToken): Promise<boolean> => {
  if (jwk.x === undefined || jwk.y === undefined) return false
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, parsed.signature, parsed.signed)
}

const verifiers = new Map<string, PrivyIdentity>()

/** The isolate's verifier for this app, so its key set and owner caches outlive one request. */
export const identityFor = (env: {
  readonly PRIVY_APP_ID: string
  readonly PRIVY_APP_SECRET: string
}): IdentityVerifier => {
  const existing = verifiers.get(env.PRIVY_APP_ID)
  if (existing !== undefined) return existing
  const verifier = new PrivyIdentity({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET })
  verifiers.set(env.PRIVY_APP_ID, verifier)
  return verifier
}
