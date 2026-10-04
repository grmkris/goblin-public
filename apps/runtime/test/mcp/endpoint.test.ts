import { describe, expect, it } from 'vitest'
import { addedServerId, serverClaims, userEndpoint } from '../../src/mcp/endpoint.ts'

const reason = (raw: string): string => {
  try {
    userEndpoint(raw)
    return 'ok'
  } catch (error) {
    return error instanceof Error && 'reason' in error ? String(error.reason) : 'thrown'
  }
}

describe('endpoints the owner may add', () => {
  it('accepts a public https URL and refuses everything that could reach a private network', () => {
    expect(userEndpoint(' https://mcp.example.com/mcp ').href).toBe('https://mcp.example.com/mcp')
    expect(reason('http://mcp.example.com/mcp')).toBe('endpoint_not_https')
    expect(reason('https://user:pw@mcp.example.com/mcp')).toBe('endpoint_invalid')
    expect(reason('https://mcp.example.com/mcp#x')).toBe('endpoint_invalid')
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'intranet', 'nas.local', 'db.internal', 'a.home.arpa'])
      expect(reason(`https://${host}/mcp`)).toBe('endpoint_not_public')
    expect(reason('not a url')).toBe('endpoint_not_a_url')
    expect(reason(`https://example.com/${'x'.repeat(2050)}`)).toBe('endpoint_too_long')
  })
  it('names an added server by its host, never reusing a taken id', () => {
    const random = (() => {
      const values = ['aaaaaa', 'bbbbbb']
      return () => values.shift() ?? 'zzzzzz'
    })()
    const url = new URL('https://www.Mcp.Example.com/mcp')
    expect(addedServerId(url, new Set(['mcp-example-com-aaaaaa']), random)).toBe('mcp-example-com-bbbbbb')
    expect(addedServerId(url, new Set(), () => '123456')).toMatch(/^[\w-]{1,64}$/u)
  })
})

/** A fetch that answers every request with `body` as the server card. */
const card =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('server cards', () => {
  const endpoint = new URL('https://mcp.example.com/mcp')

  it('labels a server from its card: title (or name), description and an https icon', async () => {
    const claims = await serverClaims(
      endpoint,
      card({
        name: 'com.example/notes',
        title: '  Notes  ',
        description: 'Your notes.',
        icons: [{ src: 'http://insecure.test/i.png' }, { src: 'https://cdn.example.com/i.png' }],
      }),
    )
    expect(claims).toEqual({ title: 'Notes', description: 'Your notes.', icon: 'https://cdn.example.com/i.png' })
    expect(await serverClaims(endpoint, card({ name: 'com.example/notes' }))).toEqual({ title: 'com.example/notes' })
  })
  it('says nothing when the card is missing, malformed or oversized', async () => {
    expect(await serverClaims(endpoint, card('not found', 404))).toEqual({})
    expect(await serverClaims(endpoint, card('{oops'))).toEqual({})
    expect(await serverClaims(endpoint, card({ title: 7 }))).toEqual({})
    expect(await serverClaims(endpoint, card(`{"title":"${'x'.repeat(70_000)}"}`))).toEqual({})
  })
})
