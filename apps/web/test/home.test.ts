import { describe, expect, it } from 'vitest'
import { hasSessionCookie, homeFor } from '../src/lib/home.ts'

const cookies =
  (jar: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    jar[name]

describe('Home', () => {
  it('sends a request with a session cookie to a channel, under either name, and one without to the landing', () => {
    expect(hasSessionCookie(cookies({ '__Secure-better-auth.session_token': 'abc.def' }))).toBe(true)
    expect(hasSessionCookie(cookies({ 'better-auth.session_token': 'abc.def' }))).toBe(true)
    expect(hasSessionCookie(cookies({}))).toBe(false)
    expect(hasSessionCookie(cookies({ 'better-auth.session_token': '' }))).toBe(false)
    expect(hasSessionCookie(cookies({ 'better-auth.session_data': 'abc' }))).toBe(false)
  })

  it('opens the channel it is given for a signed-in owner and nothing for a visitor', () => {
    expect(homeFor(true, '1')).toBe('1')
    expect(homeFor(true, '7')).toBe('7')
    expect(homeFor(false, '7')).toBeUndefined()
  })
})
