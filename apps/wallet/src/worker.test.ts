import { describe, expect, test } from 'vitest'
import { testEnv } from './test-env.ts'
import worker from './worker.ts'

const envWith = testEnv

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

  test('GET /api/config serves the public Privy app id and the stage', async () => {
    expect(await (await get('/api/config')).json()).toEqual({ privyAppId: 'app-123', stage: 'testnet' })
  })

  test('everything else is a JSON 404', async () => {
    for (const [path, method] of [
      ['/nope', 'GET'],
      ['/health', 'POST'],
      ['/api/unknown', 'GET'],
    ] as const) {
      const response = await get(path, method)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
    }
  })
})

describe('mcp', () => {
  test('POST /mcp without a token is answered with the OAuth challenge', async () => {
    const response = await worker.fetch(
      new Request('https://wallet.test/mcp', { method: 'POST', headers: { host: 'wallet.test' } }),
      envWith({}),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })
})

describe('views', () => {
  test('GET /views/* is served from the assets binding', async () => {
    const response = await get('/views/dashboard.html')
    expect(await response.text()).toBe('asset')
  })
})
