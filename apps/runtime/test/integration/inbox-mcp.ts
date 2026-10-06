import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import { Schema } from 'effect'

/** No-auth, in-Worker inbox MCP fixture. Only synthetic rows leave this transport. */
export class InboxMcpFixture {
  calls = 0
  failed = false
  readonly #handler = createMcpHandler(() => {
    // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK serves this bounded local transport fixture.
    const server = new Server({ name: 'inbox-fixture', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: [{ name: 'message_list', inputSchema: { type: 'object' as const } }],
    }))
    server.setRequestHandler(
      'tools/call',
      { params: Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String })) },
      () => {
        this.calls += 1
        const messages = Array.from({ length: 8 }, (_, index) => ({
          id: `fixture-${index}`,
          subject: `Message ${index}`,
          sender: 'Fixture sender',
          receivedAt: index,
        }))
        return {
          content: [],
          structuredContent: { messages: this.failed ? 'invalid fixture result' : messages },
        }
      },
    )
    return server
  })
  readonly fetch: typeof fetch = (input, init) => this.#handler.fetch(new Request(input, init))
}
