// oxlint-disable typescript/no-deprecated -- the SDK deprecates its low-level Server for McpServer; fixtures need it.
import { CLIENT_CAPABILITIES_META_KEY, Server } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'

/**
 * The MCP SDK's low-level `Server`, for a test's fixture server: it answers exactly the requests the test registers,
 * with the lists and metadata the test gives (unknown fields kept byte for byte) and draft methods such as the Skills
 * extension's, where `McpServer` would derive them through its schema adapters.
 */
export const lowLevelServer = (...options: ConstructorParameters<typeof Server>): Server => new Server(...options)

/** A request's envelope (`ctx.mcpReq.envelope`) when it declares URL elicitation (ADR 0042). */
const UrlElicitationEnvelope = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Struct({
    elicitation: Schema.Struct({ url: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
})

/** Whether the request whose envelope a fixture handler reads declared URL elicitation for itself. */
export const declaresUrlElicitation = (envelope: unknown): boolean => Schema.is(UrlElicitationEnvelope)(envelope)
