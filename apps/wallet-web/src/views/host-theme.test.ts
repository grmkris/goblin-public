import { describe, expect, it } from 'vitest'
import { insetsOf, tokensFromHost } from './host-theme.ts'

describe('tokensFromHost', () => {
  it('maps the host variables it sends and leaves the rest to our tokens', () => {
    const tokens = tokensFromHost({
      '--color-background-primary': 'rgb(1 2 3)',
      '--color-text-primary': ' #fff ',
      '--color-text-danger': undefined,
    })
    expect(tokens['--background']).toBe('rgb(1 2 3)')
    expect(tokens['--foreground']).toBe('#fff')
    expect(tokens['--card']).toBe('rgb(1 2 3)')
    expect(tokens['--destructive']).toBeUndefined()
    expect(tokens['--border']).toBeUndefined()
  })

  it('maps nothing when the host sends no styles', () => {
    expect(tokensFromHost(undefined)).toEqual({})
  })
})

describe('insetsOf', () => {
  it('defaults every inset to zero', () => {
    expect(insetsOf(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(insetsOf({ safeAreaInsets: { top: 8, right: 0, bottom: 4, left: 0 } }).bottom).toBe(4)
  })
})
