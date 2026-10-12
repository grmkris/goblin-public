import type { WalletEnv } from './env.ts'

const unused = (): never => {
  throw new Error('not used by these tests')
}

const stubNamespace: DurableObjectNamespace = {
  newUniqueId: unused,
  idFromName: unused,
  idFromString: unused,
  get: unused,
  getByName: unused,
  jurisdiction: () => stubNamespace,
}

/** A Worker environment for tests: assets answer "asset", the Durable Object namespaces are not reachable. */
export const testEnv = (extra: Partial<WalletEnv> = {}): WalletEnv => ({
  ASSETS: { fetch: () => Promise.resolve(new Response('asset')), connect: unused },
  LEDGER: stubNamespace,
  AUTH: stubNamespace,
  RELAY: stubNamespace,
  PRIVY_APP_ID: 'app-123',
  PRIVY_SIGNER_ID: '',
  PRIVY_POLICY_ID: '',
  PRIVY_APP_SECRET: '',
  PRIVY_AUTHORIZATION_KEY: '',
  RELAY_PRIVATE_KEY: '',
  RPC_URLS: '',
  WALLET_LIVE: '0',
  ...extra,
})
