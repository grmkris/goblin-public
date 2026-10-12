import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { nowSeconds } from '../clock.ts'
import { Internal, UpstreamMcp } from '../http/errors.ts'
import type { Credentials } from './credentials.ts'

/**
 * How one OAuth exchange runs:
 * - `interactive`: the owner pressed Connect; the authorization URL is captured for the browser redirect.
 * - `background`: refresh during a call; if the server wants a new authorization the server is marked `needs_auth`.
 *   The SDK also asks for a new authorization when the refresh never got an answer (the network, a 5xx): `reached`
 *   then says so, and the refresh fails as that transport failure instead, keeping the credentials.
 * - `callback`: completing an authorization with the PKCE verifier stored for its `state`.
 */
export type OAuthMode =
  | { readonly kind: 'interactive' }
  | { readonly kind: 'background'; readonly reached?: () => boolean }
  | { readonly kind: 'callback'; readonly codeVerifier: string }

/**
 * The name goblin registers under with every authorization server: a consent screen names the app, `goblin`, and the
 * connection's label stays goblin's own (ADR 0048).
 */
const CLIENT_NAME = 'goblin'

/**
 * The MCP SDK's `OAuthClientProvider` over the Agent DO's encrypted credential store. The SDK does discovery,
 * dynamic client registration, PKCE, code exchange and refresh; this class only persists what it hands over.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  readonly #store: Credentials
  readonly #connectionId: string
  readonly #redirectUrl: string
  readonly #appUrl: string
  readonly #mode: OAuthMode
  #codeVerifier: string | undefined
  /** Set by `redirectToAuthorization` in interactive mode. */
  authorizationUrl: URL | undefined

  constructor(store: Credentials, connectionId: string, appUrl: string, mode: OAuthMode) {
    this.#store = store
    this.#connectionId = connectionId
    this.#appUrl = appUrl.replace(/\/$/u, '')
    this.#redirectUrl = `${this.#appUrl}/api/mcp/oauth/callback`
    this.#mode = mode
  }

  get redirectUrl(): string {
    return this.#redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      client_uri: this.#appUrl,
      redirect_uris: [this.#redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return crypto.randomUUID()
  }

  clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    return this.#store.clientInformation(this.#connectionId)
  }

  saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    return this.#store.saveClientInformation(this.#connectionId, info, nowSeconds())
  }

  tokens(): Promise<StoredOAuthTokens | undefined> {
    return this.#store.tokens(this.#connectionId)
  }

  saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    return this.#store.saveTokens(this.#connectionId, tokens, nowSeconds())
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (this.#mode.kind === 'callback') return this.#mode.codeVerifier
    if (this.#codeVerifier !== undefined) return this.#codeVerifier
    throw new Internal({ reason: 'no PKCE verifier for this exchange' })
  }

  /** Persist the pending exchange under the URL's `state`; only an interactive Connect returns the URL. */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.#mode.kind === 'background' && this.#mode.reached?.() === false)
      throw new UpstreamMcp({ connectionId: this.#connectionId, reason: 'transport' })
    if (this.#mode.kind !== 'interactive') {
      this.#store.markNeedsAuth(this.#connectionId, nowSeconds())
      return
    }
    const state = authorizationUrl.searchParams.get('state')
    if (state === null || this.#codeVerifier === undefined)
      throw new Internal({ reason: 'authorization request without state or verifier' })
    await this.#store.savePending(state, this.#connectionId, this.#codeVerifier, nowSeconds())
    this.authorizationUrl = authorizationUrl
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.#store.invalidate(this.#connectionId, scope, nowSeconds())
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#store.saveDiscoveryState(this.#connectionId, state, nowSeconds())
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#store.discoveryState(this.#connectionId)
  }
}
