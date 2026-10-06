import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'

/** Loopback, no-auth MCP fixture, never part of the deployed Worker. */
const port = Number(Bun.argv[2] ?? 18995)
const uri = 'ui://fixture-board/board.html'
const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/client.mts`],
  target: 'browser',
  format: 'esm',
  minify: true,
})
const output = built.outputs[0]
if (!built.success || output === undefined) throw new Error('Fixture App bundle failed')
const script = (await output.text()).replaceAll('</script', '<\\/script')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:13px system-ui;margin:8px;color:var(--color-text-primary);background:var(--color-background-primary)}button{margin:2px}
</style></head><body><p id="out">loading</p><p id="result"></p>
<button id="inc">Add one</button><button id="full">Fullscreen</button><button id="back">Inline</button>
<button id="share">Share</button><button id="call">Call tool</button><script type="module">${script}</script></body></html>`
const params = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const handler = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK serves this bounded no-auth browser fixture.
  const server = new Server({ name: 'fixture-board', version: '1' }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: 'board',
        title: 'Fixture board',
        inputSchema: { type: 'object' as const },
        _meta: { ui: { resourceUri: uri } },
      },
    ],
  }))
  server.setRequestHandler('resources/list', () => ({
    resources: [{ uri, name: 'Board', mimeType: 'text/html;profile=mcp-app' }],
  }))
  server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
  server.setRequestHandler(
    'resources/read',
    { params: Schema.toStandardSchemaV1(Schema.Struct({ uri: Schema.String })) },
    (request) => ({ contents: [{ uri: request.uri, mimeType: 'text/html;profile=mcp-app', text: html }] }),
  )
  server.setRequestHandler('tools/call', { params: Schema.toStandardSchemaV1(params) }, (request) => ({
    content: [{ type: 'text' as const, text: `board ${JSON.stringify(request.arguments ?? {})}` }],
  }))
  return server
})
Bun.serve({ port, hostname: '127.0.0.1', fetch: (request) => handler.fetch(request) })
console.log(`MCP App fixture on loopback port ${port}`)
