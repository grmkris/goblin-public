import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { spawn } from 'node:child_process'
import { CliAuthProvider, listenForCallback } from './oauth.ts'
import type { Settings } from './config.ts'
import { CredentialStore } from './store.ts'

const VERSION = '0.1.0'

const open = async (endpoint: URL, provider: CliAuthProvider): Promise<Client> => {
  const client = new Client({ name: 'goblin-cli', version: VERSION })
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }))
  return client
}

/** Ask the browser to open the page, where there is one to ask; the URL is printed either way. */
function launch(url: URL): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (command === undefined) return
  // No browser here (a headless box): the printed URL is the way in.
  spawn(command, [url.href], { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref()
}

/**
 * An MCP client of the endpoint, signed in. With stored tokens it connects straight away (refreshing them if they
 * expired); otherwise the SDK registers the CLI, the user approves in the browser, and the callback finishes the
 * sign-in before connecting again.
 */
export async function connect(settings: Settings, browser: boolean): Promise<Client> {
  const store = new CredentialStore(settings.store)
  let waiting: Promise<URLSearchParams> | undefined
  const provider = new CliAuthProvider(store, settings.endpoint.href, settings.redirect.href, settings.scope, (url) => {
    console.error(`Sign in and approve goblin's inspection access:\n\n  ${url.href}\n`)
    if (browser) launch(url)
    waiting = listenForCallback(settings.redirect, process.stdin.isTTY).then((callback) => callback.params)
  })
  try {
    return await open(settings.endpoint, provider)
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || waiting === undefined) throw error
  }
  const params = await waiting
  if (params.get('state') !== provider.expectedState) throw new Error('The sign-in answer does not match this request.')
  const failure = params.get('error')
  if (failure !== null) throw new Error(`Sign-in refused: ${params.get('error_description') ?? failure}`)
  await new StreamableHTTPClientTransport(settings.endpoint, { authProvider: provider }).finishAuth(params)
  return open(settings.endpoint, provider)
}

/** Forget the endpoint's sign-in on this machine (the client stays registered until revoked in Settings). */
export async function logout(settings: Settings): Promise<void> {
  await new CredentialStore(settings.store).remove(settings.endpoint.href)
}
