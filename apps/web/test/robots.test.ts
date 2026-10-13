import { describe, expect, it } from 'vitest'
import { robotsTxt } from '../src/lib/robots.ts'

describe('robots.txt', () => {
  it('lets crawlers read production, never its API, and keeps them out of every other stage', () => {
    expect(robotsTxt('prod')).toBe('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\n')
    for (const stage of ['dev', 'local', 'test', undefined])
      expect(robotsTxt(stage)).toBe('User-agent: *\nDisallow: /\n')
  })
})
