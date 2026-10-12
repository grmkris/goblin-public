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

  it('does not call out when signed out', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpApi(() => Promise.resolve(null)).me()).rejects.toMatchObject({ code: 'signed_out' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
