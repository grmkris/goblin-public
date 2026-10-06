import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline/promises'
import type { CredentialStore } from './store.ts'

/** The stored client and tokens, read back with exactly the fields the SDK needs. */
const ClientInformation = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  client_id_issued_at: Schema.optional(Schema.Number),
  client_secret_expires_at: Schema.optional(Schema.Number),
  issuer: Schema.optional(Schema.String),
})
const Tokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
})
const decodeClient = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(ClientInformation)(value))
const decodeTokens = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(Tokens)(value))

/**
 * The CLI as an OAuth client of one goblin endpoint (RFC 8252 native app): a dynamically registered public client with
 * a loopback redirect, PKCE, and its client and tokens in the credential store under the endpoint's URL.
 */
export class CliAuthProvider implements OAuthClientProvider {
  readonly #store: CredentialStore
  readonly #key: string
  readonly #redirect: string
  readonly #scope: string
  readonly #authorize: (url: URL) => void
  #verifier: string | undefined
  #state: string | undefined

  constructor(store: CredentialStore, key: string, redirect: string, scope: string, authorize: (url: URL) => void) {
    this.#store = store
    this.#key = key
    this.#redirect = redirect
    this.#scope = scope
    this.#authorize = authorize
  }

  get redirectUrl(): string {
    return this.#redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'goblin CLI',
      redirect_uris: [this.#redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.#scope,
    }
  }

  /** The state this authorization sent; the callback must carry it back. */
  get expectedState(): string | undefined {
    return this.#state
  }

  state(): string {
    this.#state = crypto.randomUUID()
    return this.#state
  }

  /** A client registered for another redirect (another port) cannot use this one: register again. */
  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const entry = await this.#store.read(this.#key)
    return entry.redirectUri === this.#redirect ? decodeClient(entry.client) : undefined
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.#store.update(this.#key, { redirectUri: this.#redirect, client })
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return decodeTokens((await this.#store.read(this.#key)).tokens)
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.#store.update(this.#key, { tokens })
  }

  redirectToAuthorization(url: URL): void {
    this.#authorize(url)
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier
  }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new Error('no authorization in progress')
    return this.#verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') await this.#store.remove(this.#key)
    else if (scope === 'client') await this.#store.forget(this.#key, ['client', 'tokens'])
    else if (scope === 'tokens') await this.#store.forget(this.#key, ['tokens'])
    else if (scope === 'verifier') this.#verifier = undefined
  }
}

const DONE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>goblin</title><p>Signed in. You can close this tab and go back to the terminal.</p>'

/**
 * Listen for the authorization response: whichever comes first of the browser reaching the loopback redirect, or the
 * user pasting the URL the browser was sent to (a browser on another machine than the terminal cannot reach loopback).
 * Resolves once listening; `params` resolves with the response, after which the listener is gone.
 */
export async function listenForCallback(
  redirect: URL,
  interactive: boolean,
): Promise<{ readonly params: Promise<URLSearchParams> }> {
  const { promise, resolve } = Promise.withResolvers<URLSearchParams>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', redirect)
    if (url.pathname !== redirect.pathname) {
      response.writeHead(404).end('Not found')
      return
    }
    resolve(url.searchParams)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
  })
  await new Promise<void>((listening, failed) => {
    server.once('error', failed)
    server.listen(Number(redirect.port), redirect.hostname, listening)
  })
  const pasted = new AbortController()
  if (interactive) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    void prompt
      .question('Or paste the URL your browser was sent to: ', { signal: pasted.signal })
      .then((line) => {
        if (URL.canParse(line.trim())) resolve(new URL(line.trim()).searchParams)
      })
      .catch(() => undefined)
      .finally(() => prompt.close())
  }
  const params = promise.finally(() => {
    pasted.abort()
    server.closeAllConnections()
    server.close()
  })
  return { params }
}
