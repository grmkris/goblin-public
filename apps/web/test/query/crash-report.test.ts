import { BILLING_REFUSALS, BillingRefused, Conflict, NotFound } from '@goblin/contracts/api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { account, reportCrash } from '../../src/lib/api.ts'
import { BILLING_KINDS, describeError, messageOf } from '../../src/lib/query/app-error.ts'
import { crashReport, crashReporter, framesOf, reportUncaught } from '../../src/lib/query/crash-report.ts'

const SECRET = 'what the owner typed'

/** An error whose stack is `lines`, under Chrome's `name: message` header. */
const thrown = (message: string, lines: readonly string[], name = 'TypeError'): Error => {
  const error = new TypeError(message)
  error.name = name
  error.stack = [`${name}: ${message}`, ...lines].join('\n')
  return error
}

describe('a crash report', () => {
  it('keeps the stack locations only, without query or fragment, never the message', () => {
    const error = thrown(`${SECRET}\n    at fake (https://evil.test/${SECRET}.js:1:1)`, [
      '    at render (https://goblin.test/assets/index-3f2a.js?v=2:1:2345)',
      '    at https://goblin.test/assets/vendor-9b1c.js:12:40',
      '    at async Promise.all (index 0)',
    ])
    expect(framesOf(error)).toEqual([
      'https://goblin.test/assets/index-3f2a.js:1:2345',
      'https://goblin.test/assets/vendor-9b1c.js:12:40',
    ])
    expect(framesOf(thrown('x', ['render@https://goblin.test/assets/a.js:3:4']))).toEqual([
      'https://goblin.test/assets/a.js:3:4',
    ])
    const report = crashReport(error, '/c/$chatId')
    expect(report).toEqual({
      route: '/c/$chatId',
      name: 'TypeError',
      frames: ['https://goblin.test/assets/index-3f2a.js:1:2345', 'https://goblin.test/assets/vendor-9b1c.js:12:40'],
      build: 'dev',
    })
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it("names a tagged error by its tag, quotes a failed answer's reference, and bounds the whole report", () => {
    expect(crashReport(new Conflict({ reason: SECRET, ref: '7f3a9c12e4b5-AMS' }), '/')).toMatchObject({
      name: 'Conflict',
      ref: '7f3a9c12e4b5-AMS',
    })
    expect(crashReport(new NotFound({ what: SECRET, ref: 'ray-404' }), '/')).toMatchObject({
      name: 'NotFound',
      ref: 'ray-404',
    })
    expect(crashReport(SECRET, `/c/${SECRET}`)).toEqual({ route: '__root__', name: 'Error', frames: [], build: 'dev' })
    const long = Array.from(
      { length: 12 },
      (_, line) => `    at f (https://goblin.test/${'a'.repeat(250)}.js:${line}:1)`,
    )
    const report = crashReport(thrown('x', long), '/')
    expect(report?.frames.length).toBeLessThan(12)
    expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(2048)
  })

  it('reports a defect only, never an answer the API gave', () => {
    const sent: unknown[] = []
    const report = crashReporter((value) => sent.push(value))
    report(new Conflict({ reason: 'x', ref: 'ray-409' }), '/')
    report(new NotFound({ what: 'x', ref: 'ray-404' }), '/')
    report(new BillingRefused({ code: 'checkout_limit' }), '/subscribe')
    expect(sent).toHaveLength(0)
    report(thrown('x', ['    at f (https://goblin.test/a.js:1:1)']), '/')
    expect(sent).toHaveLength(1)
  })

  it('goes once per distinct crash, five at most per page load', () => {
    const sent: unknown[] = []
    const report = crashReporter((value) => sent.push(value))
    const error = thrown('x', ['    at f (https://goblin.test/a.js:1:1)'])
    report(error, '/')
    report(error, '/settings')
    expect(sent).toHaveLength(1)
    for (let line = 2; line < 10; line++) report(thrown('x', [`    at f (https://goblin.test/a.js:${line}:1)`]), '/')
    expect(sent).toHaveLength(5)
  })

  it('hears uncaught errors and rejections, but not a cross-origin script error that says nothing', () => {
    const listeners = new Map<string, (event: { error?: unknown; reason?: unknown }) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: { error?: unknown; reason?: unknown }) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    }
    const heard: (readonly [unknown, string])[] = []
    // SAFETY: the fake target keeps the listeners it is given; only `addEventListener` and `removeEventListener` are used.
    const stop = reportUncaught(
      target as never,
      (error, route) => heard.push([error, route]),
      () => '/tasks',
    )
    listeners.get('error')?.({ error: null })
    listeners.get('error')?.({ error: 'boom' })
    listeners.get('unhandledrejection')?.({ reason: 'nope' })
    expect(heard).toEqual([
      ['boom', '/tasks'],
      ['nope', '/tasks'],
    ])
    stop()
    expect(listeners.size).toBe(0)
  })
})

describe('the account API client', () => {
  const sent: Request[] = []
  beforeAll(() => {
    vi.stubGlobal('location', new URL('http://app.test/'))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init))
      return new Response(null, { status: 204 })
    })
  })
  afterAll(async () => {
    vi.unstubAllGlobals()
    await account.runtime.dispose()
  })

  it('posts a crash report with the CSRF header', async () => {
    reportCrash(thrown('x', ['    at f (https://goblin.test/b.js:1:1)']), '/c/$chatId')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const [request] = sent
    expect(new URL(request?.url ?? '').pathname).toBe('/api/client-errors')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('x-goblin-csrf')).toBe('1')
    expect(await request?.json()).toEqual({
      route: '/c/$chatId',
      name: 'TypeError',
      frames: ['https://goblin.test/b.js:1:1'],
      build: 'dev',
    })
  })

  it('words a billing refusal with its copy, kind and reference', () => {
    const refused = new BillingRefused({ code: 'checkout_limit', ref: 'ray-429-abcdef' })
    expect(describeError(refused)).toMatchObject({
      kind: BILLING_KINDS.checkout_limit,
      code: 'checkout_limit',
      status: BILLING_REFUSALS.checkout_limit.status,
      retryable: false,
      ref: 'ray-429-abcdef',
    })
    expect(
      messageOf(new BillingRefused({ code: 'billing_unavailable' }), 'start checkout', { showRecovery: true }),
    ).toBe('Checkout is being set up. Please try again later.')
  })
})
