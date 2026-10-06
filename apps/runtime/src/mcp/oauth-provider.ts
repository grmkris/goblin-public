import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { nowSeconds } from '../clock.ts'
import { Internal } from '../http/errors.ts'
import type { Credentials } from './credentials.ts'

/**
 * How one OAuth exchange runs:
 * - `interactive`: the owner pressed Connect; the authorization URL is captured for the browser redirect.
 * - `background`: refresh during a call; if the server wants a new authorization the server is marked `needs_auth`.
 * - `callback`: completing an authorization with the PKCE verifier stored for its `state`.
 */
export type OAuthMode =
  | { readonly kind: 'interactive' }
  | { readonly kind: 'background' }
  | { readonly kind: 'callback'; readonly codeVerifier: string }

/**
 * The MCP SDK's `OAuthClientProvider` over the Agent DO's encrypted credential store. The SDK does discovery,
 * dynamic client registration, PKCE, code exchange and refresh; this class only persists what it hands over.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  readonly #store: Credentials
  readonly #serverId: string
  readonly #redirectUrl: string
  readonly #appUrl: string
  readonly #mode: OAuthMode
  #codeVerifier: string | undefined
  /** Set by `redirectToAuthorization` in interactive mode. */
  authorizationUrl: URL | undefined

  constructor(store: Credentials, serverId: string, appUrl: string, mode: OAuthMode) {
    this.#store = store
    this.#serverId = serverId
    this.#appUrl = appUrl.replace(/\/$/u, '')
    this.#redirectUrl = `${this.#appUrl}/api/mcp/oauth/callback`
    this.#mode = mode
  }

  get redirectUrl(): string {
    return this.#redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'goblin',
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
    return this.#store.clientInformation(this.#serverId)
  }

  saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    return this.#store.saveClientInformation(this.#serverId, info, nowSeconds())
  }

  tokens(): Promise<StoredOAuthTokens | undefined> {
    return this.#store.tokens(this.#serverId)
  }

  saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    return this.#store.saveTokens(this.#serverId, tokens, nowSeconds())
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
    if (this.#mode.kind !== 'interactive') {
      this.#store.markNeedsAuth(this.#serverId, nowSeconds())
      return
    }
    const state = authorizationUrl.searchParams.get('state')
    if (state === null || this.#codeVerifier === undefined)
      throw new Internal({ reason: 'authorization request without state or verifier' })
    await this.#store.savePending(state, this.#serverId, this.#codeVerifier, nowSeconds())
    this.authorizationUrl = authorizationUrl
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.#store.invalidate(this.#serverId, scope, nowSeconds())
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#store.saveDiscoveryState(this.#serverId, state, nowSeconds())
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#store.discoveryState(this.#serverId)
  }
}
