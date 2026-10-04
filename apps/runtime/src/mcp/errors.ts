import { ProtocolError, SdkError, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client'
import { type AppError, Internal, UpstreamMcp, toAppError } from '../http/errors.ts'

/**
 * Map an SDK or transport failure to a safe `UpstreamMcp`; app errors raised by our own code pass through. The remote
 * payload, token, request and response are never retained.
 */
export const mapMcpError = (error: unknown, serverId: string): AppError => {
  if (UnauthorizedError.isInstance(error)) return new UpstreamMcp({ serverId, reason: 'unauthorized' })
  if (ProtocolError.isInstance(error)) return new UpstreamMcp({ serverId, reason: 'remote-rpc', code: error.code })
  if (SdkHttpError.isInstance(error)) return new UpstreamMcp({ serverId, reason: 'transport' })
  if (SdkError.isInstance(error) && /timeout/iu.test(error.message))
    return new UpstreamMcp({ serverId, reason: 'timeout' })
  if (error instanceof DOMException && error.name === 'AbortError')
    return new UpstreamMcp({ serverId, reason: 'cancelled' })
  const known = toAppError(error)
  return known instanceof Internal ? new UpstreamMcp({ serverId, reason: 'transport' }) : known
}
