import { describe, expect, it } from 'vitest'
import { requestTool } from '../src/pi/servers.ts'
import { executeTool } from './pi-tool.ts'

const ask = (endpoint: string) => executeTool(requestTool, { endpoint, name: 'Maps', reason: 'To show routes' })

describe('mcp_request_server (unit)', () => {
  it('asks the owner with a card, and ends the run until they reply', async () => {
    const result = await ask('https://mcp.example.com/mcp')
    const request = { endpoint: 'https://mcp.example.com/mcp', name: 'Maps', reason: 'To show routes' }
    expect(result.details).toEqual({ kind: 'server-request', ...request, structuredContent: request })
    expect(result.control).toEqual({ terminate: true })
  })
  it('refuses an address that is not https or carries credentials', async () => {
    for (const endpoint of ['http://mcp.example.com/mcp', 'https://user:pw@mcp.example.com/', 'not a url'])
      expect(await ask(endpoint)).toMatchObject({ isError: true })
  })
})
