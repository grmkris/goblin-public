import { describe, expect, it } from 'vitest'
import { listenForCallback } from '../src/oauth.ts'

describe('the sign-in callback (unit)', () => {
  it('takes the authorization response the browser brings to the loopback redirect', async () => {
    const port = 40_000 + Math.floor(Math.random() * 10_000)
    const redirect = new URL(`http://127.0.0.1:${port}/callback`)
    const { params: waiting } = await listenForCallback(redirect, false)
    expect((await fetch(new URL('/elsewhere', redirect))).status).toBe(404)
    const page = await fetch(`${redirect.href}?code=abc&state=s1`)
    expect(page.status).toBe(200)
    const params = await waiting
    expect([params.get('code'), params.get('state')]).toEqual(['abc', 's1'])
    await expect(fetch(redirect)).rejects.toThrow()
  })
})
