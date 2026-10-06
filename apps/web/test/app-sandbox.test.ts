import { describe, expect, it } from 'vitest'
import {
  agentAppCsp,
  agentAppHtml,
  appCsp,
  appSandbox,
  isSandboxMessage,
  sandboxHtml,
  sandboxProxy,
} from '../src/lib/app-sandbox.ts'

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
  it('gives the MyPlan panel what its resource declares and nothing else: no wasm, no workers, no frames', () => {
    // The panel's own end-to-end test (myapps apps/myplan-ui/test/e2e/panel.e2e.ts) passes under a stricter policy.
    const myplan = 'https://dev-new.myplan.lol'
    const policy = appCsp({
      ui: { csp: { connectDomains: [myplan, 'wss://dev-new.myplan.lol'], resourceDomains: [myplan] } },
    })
    expect(policy).toContain(`connect-src ${myplan} wss://dev-new.myplan.lol`)
    expect(policy).toContain(`img-src data: blob: ${myplan}`)
    expect(policy).toContain(`script-src 'unsafe-inline' ${myplan}`)
    expect(policy).not.toContain('wasm-unsafe-eval')
    expect(policy).not.toContain('worker-src')
    expect(policy).toContain("frame-src 'none'")
  })
  it('prepends restrictive CSP and creates nested opaque frames without same-origin authority', () => {
    expect(sandboxHtml('<h1>App</h1>', {})).toContain("connect-src 'none'")
    const html = sandboxProxy('https://goblin.example.test')
    expect(html).toContain("frame.setAttribute('sandbox',event.data.params.sandbox===")
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

const assets = {
  origin: 'https://goblin.example.test',
  scripts: {
    core: 'https://goblin.example.test/assets/core-1.js',
    charts: 'https://goblin.example.test/assets/charts-1.js',
    maps: 'https://goblin.example.test/assets/maps-1.js',
    diagrams: 'https://goblin.example.test/assets/diagrams-1.js',
    mdxcn: 'https://goblin.example.test/assets/mdxcn-1.js',
    icons: 'https://goblin.example.test/assets/icons-1.js',
  },
  styles: { ui: '.ui{}', maps: '.leaflet{}' },
}

describe("an agent app's frame", () => {
  it('has no network, loads scripts only from goblin and tiles only for maps', () => {
    const plain = agentAppCsp(assets.origin, [])
    expect(plain).toContain("connect-src 'none'")
    expect(plain).toContain("script-src 'unsafe-inline' https://goblin.example.test;")
    expect(plain).not.toContain('openstreetmap')
    expect(agentAppCsp(assets.origin, ['maps'])).toContain('img-src data: blob: https://tile.openstreetmap.org;')
  })
  it('loads the core and the bundles the view needs, then runs its module on the first state', () => {
    const html = agentAppHtml(
      { module: 'exports.default = function View() { return "</script><b>" }', css: '.p-4{}', libs: ['maps'] },
      assets,
    )
    expect(html.indexOf('core-1.js')).toBeLessThan(html.indexOf('maps-1.js'))
    expect(html).not.toContain('charts-1.js')
    expect(html).toContain('<style>.leaflet{}</style><style>.p-4{}</style>')
    expect(html).toContain('__goblinStart(function () {')
    // The module cannot end its script element early.
    expect(html).toContain('return "<\\/script><b>"')
    expect(html.match(/<\/script>/gu)).toHaveLength(4)
  })
  it('keeps errors from before the core starts, so a bundle that fails as it loads is reported', () => {
    const html = agentAppHtml({ module: 'exports.default = function View() {}', css: '', libs: ['diagrams'] }, assets)
    expect(html.indexOf('window.__goblinEarly=[]')).toBeLessThan(html.indexOf('core-1.js'))
    expect(html).toContain("addEventListener('error'")
    expect(html).toContain("addEventListener('unhandledrejection'")
  })
  it('loads mdxcn on the core React without adding a network capability or other bundles', () => {
    const html = agentAppHtml({ module: 'exports.default = function View() {}', css: '', libs: ['mdxcn'] }, assets)
    expect(html.indexOf('core-1.js')).toBeLessThan(html.indexOf('mdxcn-1.js'))
    expect(html).not.toContain('maps-1.js')
    expect(html).not.toContain('charts-1.js')
    expect(html).not.toContain('openstreetmap')
    expect(html).toContain("connect-src 'none'")
  })
  it('may submit forms (to its handlers only), while an MCP App keeps scripts alone', () => {
    expect(appSandbox('agent')).toBe('allow-scripts allow-forms')
    expect(appSandbox('mcp')).toBe('allow-scripts')
    expect(agentAppCsp(assets.origin, [])).toContain("form-action 'none'")
    expect(sandboxProxy('https://goblin.example.test')).toContain(
      "'allow-scripts allow-forms'?'allow-scripts allow-forms':'allow-scripts'",
    )
  })
  it("lets the proxy load goblin's own bundles from its origin", () => {
    expect(sandboxProxy('http://localhost:18971')).toContain(
      "script-src 'unsafe-inline' https: http://localhost:18971;",
    )
  })
})
