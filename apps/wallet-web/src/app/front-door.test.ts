import { describe, expect, it } from 'vitest'
import { frontDoor, returningOwner } from './front-door.ts'

describe('frontDoor', () => {
  it('shows the landing at / to a visitor, while Privy loads too', () => {
    expect(frontDoor({ pathname: '/', status: 'signed-out', returning: false })).toBe('landing')
    expect(frontDoor({ pathname: '/', status: 'loading', returning: false })).toBe('landing')
  })

  it('keeps the plain sign-in on every deep link', () => {
    for (const pathname of ['/approve/op_1', '/subscribe/sub_1', '/setup', '/consent', '/add-funds', '/activity'])
      expect(frontDoor({ pathname, status: 'signed-out', returning: false })).toBe('sign-in')
  })

  it('keeps the sign-in recovery when a sign-in never finished', () => {
    expect(frontDoor({ pathname: '/', status: 'stalled', returning: false })).toBe('sign-in')
  })

  it('shows a returning owner the quiet sign-in while Privy loads, and the landing once signed out', () => {
    expect(frontDoor({ pathname: '/', status: 'loading', returning: true })).toBe('sign-in')
    expect(frontDoor({ pathname: '/', status: 'signed-out', returning: true })).toBe('landing')
  })
})

const storage = (entries: Record<string, string>) => () => ({ getItem: (key: string) => entries[key] ?? null })

describe('returningOwner', () => {
  it('reads a Privy session left in the browser', () => {
    expect(returningOwner(storage({ 'privy:token': 'x' }))).toBe(true)
    expect(returningOwner(storage({ 'privy:refresh_token': 'x' }))).toBe(true)
    expect(returningOwner(storage({}))).toBe(false)
  })

  it('says no when storage is missing or refuses', () => {
    expect(returningOwner(() => undefined)).toBe(false)
    expect(
      returningOwner(() => {
        throw new Error('SecurityError')
      }),
    ).toBe(false)
    expect(
      returningOwner(() => ({
        getItem: () => {
          throw new Error('SecurityError')
        },
      })),
    ).toBe(false)
  })
})
