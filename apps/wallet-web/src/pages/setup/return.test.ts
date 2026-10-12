import { describe, expect, it } from 'vitest'
import { doneTarget, returnParam } from './return.ts'

const search = (value: string) => new URLSearchParams({ return: value })

describe('returnParam', () => {
  it('asks about absolute HTTPS URLs, and HTTP on localhost', () => {
    expect(returnParam(search('https://goblin.surf/connections/wallet'))).toBe('https://goblin.surf/connections/wallet')
    expect(returnParam(search('http://localhost:5173/'))).toBe('http://localhost:5173/')
  })
  it('ignores what could never be one of the owner’s clients', () => {
    for (const value of [
      '',
      '/home',
      'http://goblin.surf/',
      'javascript:alert(1)',
      'https://user:pw@goblin.surf/',
      `https://goblin.surf/${'a'.repeat(2048)}`,
    ])
      expect(returnParam(search(value)), value).toBeUndefined()
    expect(returnParam(new URLSearchParams())).toBeUndefined()
  })
})

describe('doneTarget', () => {
  it('goes back to the client only when the Worker vouched for it', () => {
    expect(doneTarget({ url: 'https://goblin.surf/x', host: 'goblin.surf' })).toEqual({
      href: 'https://goblin.surf/x',
      label: 'Back to goblin.surf',
    })
    expect(doneTarget({})).toEqual({ href: '/', label: 'Go to your wallet' })
    expect(doneTarget(undefined)).toEqual({ href: '/', label: 'Go to your wallet' })
  })
})
