import { ProtocolError, SdkError, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client'
export type McpErrorTag =
  | 'unauthorized'
  | 'remote-rpc'
  | 'transport'
  | 'timeout'
  | 'cancelled'
  | 'grant-denied'
  | 'unsupported'
  | 'content-limit'
/** Stable safe diagnostic error; never retain a remote error payload, token, request, or response. */
export class McpBoundaryError extends Error {
  readonly tag: McpErrorTag
  readonly serverId: string
  readonly code?: number
  constructor(tag: McpErrorTag, serverId: string, code?: number) {
    super(`mcp_${tag}`)
    this.name = 'McpBoundaryError'
    this.tag = tag
    this.serverId = serverId
    if (code !== undefined) this.code = code
  }
}
export const mapMcpError = (error: unknown, serverId: string): McpBoundaryError => {
  if (error instanceof McpBoundaryError) return error
  if (error instanceof UnauthorizedError) return new McpBoundaryError('unauthorized', serverId)
  if (error instanceof ProtocolError) return new McpBoundaryError('remote-rpc', serverId, error.code)
  if (error instanceof SdkHttpError) return new McpBoundaryError('transport', serverId)
  if (error instanceof SdkError && /timeout/i.test(error.message)) return new McpBoundaryError('timeout', serverId)
  if (error instanceof DOMException && error.name === 'AbortError') return new McpBoundaryError('cancelled', serverId)
  return new McpBoundaryError('transport', serverId)
}
