import { createMcpHandler } from '@modelcontextprotocol/server'
import { Schema } from 'effect'
import { lowLevelServer } from '../mcp/low-level-server.ts'

/** The fixture's App: `board` renders it (ADR 0020). */
export const BOARD = 'ui://apps-fixture/board.html'

/** Official MCP transport; injected only at the native fixture's fetch boundary. */
export class AppsMcpFixture {
  readonly calls: { name: string; args: unknown }[] = []
  readonly #handler = createMcpHandler(() => {
    const server = lowLevelServer(
      { name: 'apps-fixture', version: '1' },
      { capabilities: { tools: {}, resources: {} } },
    )
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'board',
          title: 'Board',
          inputSchema: { type: 'object' as const },
          _meta: { ui: { resourceUri: BOARD } },
        },
      ],
    }))
    server.setRequestHandler('resources/list', () => ({
      resources: [{ uri: BOARD, name: 'Board', mimeType: 'text/html;profile=mcp-app' }],
    }))
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
    server.setRequestHandler(
      'resources/read',
      { params: Schema.toStandardSchemaV1(Schema.Struct({ uri: Schema.String })) },
      (request) => ({
        contents: [{ uri: request.uri, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><p>board</p>' }],
      }),
    )
    server.setRequestHandler(
      'tools/call',
      {
        params: Schema.toStandardSchemaV1(
          Schema.Struct({
            name: Schema.String,
            arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
      },
      (request) => {
        this.calls.push({ name: request.name, args: request.arguments })
        return {
          content: [{ type: 'text', text: `fixture-${request.name}:${JSON.stringify(request.arguments)}` }],
        }
      },
    )
    return server
  })
  readonly fetch: typeof fetch = (input, init) => this.#handler.fetch(new Request(input, init))
}
