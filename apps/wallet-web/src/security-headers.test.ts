import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, headersFile, inlineScripts } from './security-headers.ts'

const directive = (policy: string, name: string): string[] =>
  policy
    .split('; ')
    .find((part) => part.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? []

describe('inlineScripts', () => {
  it('takes the inline bodies exactly and skips scripts loaded by src', () => {
    const html = `<head><script>\n  ;(function () {})()\n</script></head><body><script type="module" crossorigin src="/assets/index.js"></script></body>`
    expect(inlineScripts(html)).toEqual(['\n  ;(function () {})()\n'])
  })
})

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy(['sha256-abc='])

  it('runs only its own scripts and the hashed inline ones', () => {
    expect(directive(policy, 'script-src')).toEqual(["'self'", "'sha256-abc='", 'https://challenges.cloudflare.com'])
    expect(directive(policy, 'object-src')).toEqual(["'none'"])
  })

  it('may not be framed and frames only Privy and WalletConnect', () => {
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"])
    expect(directive(policy, 'frame-src')).toContain('https://auth.privy.io')
  })

  it("reaches Privy and every chain's public RPC", () => {
    const connect = directive(policy, 'connect-src')
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'https://auth.privy.io', 'https://*.rpc.privy.systems']))
    expect(connect).toEqual(expect.arrayContaining(['https://mainnet.base.org', 'https://rpc.moderato.tempo.xyz']))
  })
})

describe('headersFile', () => {
  it('applies the CSP and X-Frame-Options to every path, one header per line', () => {
    const lines = headersFile([]).trimEnd().split('\n')
    expect(lines[0]).toBe('/*')
    expect(lines.slice(1).map((line) => line.split(':')[0]?.trim())).toEqual([
      'Content-Security-Policy',
      'X-Frame-Options',
    ])
    expect(lines[2]).toBe('  X-Frame-Options: DENY')
  })
})
