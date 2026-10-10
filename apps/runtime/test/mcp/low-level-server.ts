// oxlint-disable typescript/no-deprecated -- the SDK deprecates its low-level Server for McpServer; fixtures need it.
import { Server } from '@modelcontextprotocol/server'

/**
 * The MCP SDK's low-level `Server`, for a test's fixture server: it answers exactly the requests the test registers,
 * with the lists and metadata the test gives (unknown fields kept byte for byte) and draft methods such as the Skills
 * extension's, where `McpServer` would derive them through its schema adapters.
 */
export const lowLevelServer = (...options: ConstructorParameters<typeof Server>): Server => new Server(...options)
