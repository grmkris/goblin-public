import { describe, expect, test } from 'vitest'
import type { WalletEnv } from './env.ts'
import worker from './worker.ts'

const stubNamespace: DurableObjectNamespace = {
  newUniqueId: () => {
    throw new Error('not used by these tests')
  },
  idFromName: () => {
    throw new Error('not used by these tests')
  },
  idFromString: () => {
    throw new Error('not used by these tests')
  },
  get: () => {
    throw new Error('not used by these tests')
  },
  getByName: () => {
    throw new Error('not used by these tests')
  },
  jurisdiction: () => stubNamespace,
}
const envWith = (extra: Partial<WalletEnv>): WalletEnv => ({
  ASSETS: {
    fetch: () => Promise.resolve(new Response('asset')),
    connect: () => {
      throw new Error('not used by these tests')
    },
  },
  LEDGER: stubNamespace,
  AUTH: stubNamespace,
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

const get = (path: string, method = 'GET', env = envWith({})) =>
  worker.fetch(new Request(`https://wallet.test${path}`, { method }), env)

describe('worker skeleton', () => {
  test('GET /health answers ok and lists the testnets until the wallet is live', async () => {
    const response = await get('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      live: false,
      chains: ['eip155:84532', 'eip155:11155111', 'eip155:421614', 'eip155:42431'],
    })
  })

  test('GET /health lists the mainnets when live', async () => {
    const body = await (await get('/health', 'GET', envWith({ WALLET_LIVE: '1' }))).json()
    expect(body).toEqual({
      ok: true,
      live: true,
      chains: ['eip155:8453', 'eip155:1', 'eip155:42161', 'eip155:4217'],
    })
  })

  test('GET /api/config serves the public Privy app id and nothing else', async () => {
    expect(await (await get('/api/config')).json()).toEqual({ privyAppId: 'app-123' })
  })

  test('everything else is a JSON 404', async () => {
    for (const [path, method] of [
      ['/nope', 'GET'],
      ['/health', 'POST'],
    ] as const) {
      const response = await get(path, method)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
    }
  })
})
