import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure, createHttpApi } from './http-api.ts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const token = (): Promise<string | null> => Promise.resolve('tok')

afterEach(() => vi.unstubAllGlobals())

describe('createHttpApi', () => {
  it('sends the bearer token, fills path params and decodes the response', async () => {
    const fetchMock = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(json([])))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpApi(token).disconnect('conn/1')).resolves.toEqual([])
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe('/api/connections/conn%2F1')
    expect(call?.[1]?.method).toBe('DELETE')
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe('Bearer tok')
  })

  it('turns the error envelope into a sentence with its recovery', async () => {
    const body = { error: { code: 'limit', message: 'Over the limit.', recovery: 'Raise it first.' } }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(body, 409))),
    )
    const outcome = createHttpApi(token).limits()
    await expect(outcome).rejects.toBeInstanceOf(ApiFailure)
    await expect(outcome).rejects.toMatchObject({ code: 'limit', message: 'Over the limit. Raise it first.' })
  })

  it('refuses a response that breaks the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ nope: true }))),
    )
    await expect(createHttpApi(token).me()).rejects.toThrow()
  })

  it('waits for a token that arrives a moment after the page loads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json([]))),
    )
    const tokens: (string | null)[] = [null, null, 'late']
    await expect(createHttpApi(() => Promise.resolve(tokens.shift() ?? 'late')).connections()).resolves.toEqual([])
  })

  it('asks for a deposit address and follows it by that address', async () => {
    const depositAddress = '0x1111111111111111111111111111111111111111'
    const quote = {
      requestId: 'req_1',
      depositAddress,
      from: 'arbitrum',
      asset: 'ETH',
      amount: '0.01',
      receive: 'USDC',
      expectedOut: '25.31',
      feesUsd: '0.04',
      recipient: '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17',
      timeEstimateSeconds: 30,
    }
    const fetchMock = vi.fn((path: string, _init?: RequestInit) =>
      Promise.resolve(json(path === '/api/deposits' ? quote : { depositAddress, status: 'unknown', txHashes: [] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createHttpApi(token)
    await expect(api.deposit({ from: 'arbitrum', asset: 'ETH', amount: '0.01', receive: 'USDC' })).resolves.toEqual(
      quote,
    )
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
    const body = fetchMock.mock.calls[0]?.[1]?.body
    expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({
      from: 'arbitrum',
      asset: 'ETH',
      amount: '0.01',
      receive: 'USDC',
    })
    await expect(api.depositStatus(depositAddress)).resolves.toMatchObject({ status: 'unknown' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/deposits/${depositAddress}`)
  })

  it('does not call out when signed out', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpApi(() => Promise.resolve(null)).me()).rejects.toMatchObject({ code: 'signed_out' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
