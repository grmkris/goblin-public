import {
  InsufficientScopeError,
  OAuthClientFlowError,
  OAuthError,
  ProtocolError,
  SdkError,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { type AppError, Internal, NeedsAuthorization, ScopeRequired, UpstreamMcp, toAppError } from '../http/errors.ts'

/**
 * Whether an OAuth step failed because the authorization server (or the MCP server) refused this agent: an OAuth error
 * answer (`invalid_grant`, a rejected registration), a flow the SDK refused to continue, a 401, or our own
 * `NeedsAuthorization`. Only these mean the owner must sign in again; a network or server failure does not, and nor
 * does a call beyond the granted scope, which asks for more access instead (ADR 0042).
 */
export const isOAuthRejection = (error: unknown): boolean =>
  !InsufficientScopeError.isInstance(error) &&
  (OAuthError.isInstance(error) ||
    OAuthClientFlowError.isInstance(error) ||
    UnauthorizedError.isInstance(error) ||
    error instanceof NeedsAuthorization)

/** At most this many scope tokens, and characters, are kept from a server's challenge. */
const SCOPE_TOKENS = 32
const SCOPE_CHARS = 512
/** One OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u

/** The scope a challenge asks for, as scope tokens only: anything else in the server's text is dropped. */
export const challengeScope = (scope: string | undefined): string =>
  (scope ?? '')
    .split(' ')
    .filter((token) => SCOPE_TOKEN.test(token))
    .slice(0, SCOPE_TOKENS)
    .join(' ')
    .slice(0, SCOPE_CHARS)

/**
 * Map an SDK or transport failure to a safe `UpstreamMcp`, or a call beyond the granted scope to `ScopeRequired`; app
 * errors raised by our own code pass through. The remote payload, token, request and response are never retained.
 */
export const mapMcpError = (error: unknown, connectionId: string): AppError => {
  if (InsufficientScopeError.isInstance(error))
    return new ScopeRequired({ connectionId, scope: challengeScope(error.requiredScope) })
  if (UnauthorizedError.isInstance(error)) return new UpstreamMcp({ connectionId, reason: 'unauthorized' })
  if (ProtocolError.isInstance(error)) return new UpstreamMcp({ connectionId, reason: 'remote-rpc', code: error.code })
  if (SdkHttpError.isInstance(error)) return new UpstreamMcp({ connectionId, reason: 'transport' })
  if (SdkError.isInstance(error) && /timeout/iu.test(error.message))
    return new UpstreamMcp({ connectionId, reason: 'timeout' })
  if (error instanceof DOMException && error.name === 'AbortError')
    return new UpstreamMcp({ connectionId, reason: 'cancelled' })
  const known = toAppError(error)
  return known instanceof Internal ? new UpstreamMcp({ connectionId, reason: 'transport' }) : known
}
