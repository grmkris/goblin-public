import { BillingRefused, Conflict, envelopeOf } from '@goblin/contracts/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure, failureText, request } from '../src/lib/boundary.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Answers every request with `body` and `status` (and the edge's reference when `ref` is given); keeps what was sent. */
const answering = (body: unknown, status: number, ref?: string) => {
  const sent: Request[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    sent.push(new Request(new URL(input, 'https://goblin.test'), init))
    return Response.json(body, { status, headers: ref === undefined ? {} : { 'x-goblin-ref': ref } })
  })
  return sent
}

const failureOf = async (call: Promise<unknown>): Promise<ApiFailure> => {
  const failure: unknown = await call.then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(failure instanceof ApiFailure)) throw new Error('expected an ApiFailure')
  return failure
}

describe('request', () => {
  it('sends a request id on every call and the CSRF header and operation on a write', async () => {
    const sent = answering({ ok: true }, 200)
    await request('/api/topics')
    await request('/api/topics', { body: { name: 'x' }, headers: { 'x-goblin-operation': 'op-1' } })
    expect(sent[0]?.headers.get('x-goblin-request')).toMatch(/^[0-9a-f]{8}$/u)
    expect(sent[0]?.headers.has('x-goblin-csrf')).toBe(false)
    expect(sent[1]?.headers.get('x-goblin-csrf')).toBe('1')
    expect(sent[1]?.headers.get('x-goblin-operation')).toBe('op-1')
  })

  it('reads a failure in the error envelope: its tag, reason, copy and the reference it quotes', async () => {
    answering(envelopeOf(new Conflict({ reason: 'topic_name_taken', ref: '7f3a9c12e4b5-AMS' })), 409, 'other')
    const failure = await failureOf(request('/api/topics', { body: {}, headers: { 'x-goblin-operation': 'op-2' } }))
    expect(failure).toMatchObject({ tag: 'Conflict', status: 409, reason: 'topic_name_taken', ref: '7f3a9c12e4b5-AMS' })
    expect(failure.operation).toBe('op-2')
    expect(failureText(failure)).toBe(
      'That clashes with something that is already there. Refresh and try again. · ref 7f3a9c12',
    )
  })

  it('keeps a code with no tag, and words the account API refusals', async () => {
    answering({ error: { code: 'checkout_limit', message: 'Too many.', recovery: 'Wait.' } }, 429, 'ray-429')
    const failure = await failureOf(request('/api/billing/checkout', { body: {} }))
    expect(failure).toMatchObject({ tag: 'checkout_limit', status: 429, ref: 'ray-429' })
    expect(failureText(failure)).toBe('Too many. Wait. · ref ray-429')
  })

  it("reads the older { error: Tag } body, quoting the answer's reference, else the request id", async () => {
    answering({ error: 'GrantDenied', serverId: 'myplan' }, 403, 'ray-403')
    const denied = await failureOf(request('/api/mcp/myplan/tools/call', { body: {} }))
    expect(denied).toMatchObject({ tag: 'GrantDenied', status: 403, ref: 'ray-403' })
    expect(failureText(denied)).toBe('That tool is not enabled. Turn it on under Connections. · ref ray-403')
    const sent = answering({ error: 'NotFound' }, 404)
    const missing = await failureOf(request('/api/topics/9'))
    expect(missing.ref).toBe(sent[0]?.headers.get('x-goblin-request'))
    expect(missing.request).toBe(missing.ref)
  })
})

describe('failureText', () => {
  it("words a typed client's failure in its contract copy with its reference, never its exception text", () => {
    expect(failureText(new Conflict({ reason: 'topic_name_taken', ref: '7f3a9c12e4b5-AMS' }))).toBe(
      'That clashes with something that is already there. Refresh and try again. · ref 7f3a9c12',
    )
    expect(failureText(new BillingRefused({ code: 'already_subscribed' }))).toBe('You already have Pro.')
    expect(failureText(new TypeError('boom'))).toBe('boom')
  })
})
