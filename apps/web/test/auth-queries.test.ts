import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver } from '@tanstack/react-query'
import { AuthRefused, healthQuery, requestSignInCode, signOutMutation } from '../src/auth/queries.ts'
import { messageOf } from '../src/lib/query/app-error.ts'
import { testQueryClient } from '../src/lib/query/testing.ts'

/** Answers every request with `response` and keeps what was sent. */
const answering = (response: () => Response) => {
  const sent: Request[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input instanceof Request ? input : new URL(String(input), 'http://app.test'), init))
    return response()
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the public health', () => {
  it("reads the sign-up mode, mail, Pro's prices and the wallet's origin, and anything unsaid as off or none", async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    answering(() =>
      Response.json({
        ok: true,
        signup: 'invite',
        mail: true,
        plans: [
          { id: 'day', amountUsd: '1.00', periodDays: 1 },
          { id: 'month', amountUsd: '15.00', periodDays: 30 },
        ],
        walletOrigin: 'https://wallet-dev.goblin.surf',
      }),
    )
    expect(await testQueryClient().query(healthQuery)).toEqual({
      signup: 'invite',
      mail: true,
      plans: [
        { id: 'day', amountUsd: '1.00', periodDays: 1 },
        { id: 'month', amountUsd: '15.00', periodDays: 30 },
      ],
      walletOrigin: 'https://wallet-dev.goblin.surf',
    })
    answering(() => Response.json({ ok: true }))
    expect(await testQueryClient().query(healthQuery)).toEqual({ signup: 'closed', mail: false, plans: [] })
  })
})

describe('a sign-in failure', () => {
  it("quotes the reference of the answer that refused it, Cloudflare's ray when the Worker stamped none", async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    const sent = answering(() =>
      Response.json({ error: 'busy' }, { status: 503, headers: { 'cf-ray': '8f1e2d3c4b5a6978-AMS' } }),
    )
    const failure = await testQueryClient()
      .query(healthQuery)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(failure).toMatchObject({ status: 503, ref: '8f1e2d3c4b5a6978-AMS' })
    expect(messageOf(failure, 'reach goblin')).toMatch(/^Could not reach goblin\. .+ · ref 8f1e2d3c$/u)
    expect(sent[0]?.headers.get('x-goblin-request')).toMatch(/^[0-9a-f]{8}$/u)
  })

  it('quotes the id it was sent with when nothing answered', async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const failure = await requestSignInCode('owner@example.com', '').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(failure).toMatchObject({ status: 503 })
    expect(failure instanceof AuthRefused ? failure.ref : '').toMatch(/^[0-9a-f]{8}$/u)
    expect(messageOf(failure, 'send a code')).toMatch(/ · ref [0-9a-f]{8}$/u)
  })

  it('a sign-out that fails is an AuthRefused, quoted like any other', async () => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    answering(() => Response.json({}, { status: 500 }))
    const failure = await new MutationObserver(testQueryClient(), signOutMutation).mutate().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AuthRefused)
    expect(messageOf(failure, 'sign out')).toMatch(/^Could not sign out\. .+ · ref [0-9a-f]{8}$/u)
  })
})
