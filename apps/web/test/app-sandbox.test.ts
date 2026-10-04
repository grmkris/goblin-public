import { describe, expect, it } from 'vitest'
import { appCsp, isSandboxMessage, sandboxHtml, sandboxProxy } from '../src/lib/app-sandbox.ts'

describe('MCP App sandbox boundary', () => {
  it('permits only declared HTTPS/WSS origins and rejects directive injection', () => {
    const policy = appCsp({
      ui: {
        csp: {
          connectDomains: [
            'https://api.example.test',
            'wss://events.example.test',
            'https://evil.test; script-src *',
            'https://owner:secret@example.test',
            '*',
            'http://localhost',
          ],
          resourceDomains: ['https://assets.example.test'],
          frameDomains: [],
        },
      },
    })
    expect(policy).toContain('connect-src https://api.example.test wss://events.example.test')
    expect(policy).not.toContain('evil.test')
    expect(policy).not.toContain('secret')
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
  })
  it('prepends restrictive CSP and creates nested opaque frames without same-origin authority', () => {
    expect(sandboxHtml('<h1>App</h1>', {})).toContain("connect-src 'none'")
    const html = sandboxProxy('https://purrable.example.test')
    expect(html).toContain("frame.setAttribute('sandbox','allow-scripts')")
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain("event.origin==='null'")
    expect(html).toContain('event.origin===hostOrigin')
  })
  it('requires both opaque origin and the assigned frame source', () => {
    const { port1: source, port2: other } = new MessageChannel()
    expect(isSandboxMessage({ source, origin: 'null' }, source)).toBe(true)
    expect(isSandboxMessage({ source: other, origin: 'null' }, source)).toBe(false)
    expect(isSandboxMessage({ source, origin: 'https://attacker.test' }, source)).toBe(false)
    source.close()
    other.close()
  })
})
