/**
 * The owner session that `smoke:dev` and `ui:acceptance` sign in with: `{"origin": …, "cookie": …}`, captured through a
 * real OTP login and saved in a mode-600 file (scripts/README.md).
 */
import { Option, Schema } from 'effect'
import { readFileSync, statSync } from 'node:fs'

const SavedSession = Schema.Struct({ origin: Schema.String, cookie: Schema.String })
export type Session = typeof SavedSession.Type

const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(SavedSession))

/**
 * The saved session. A file anyone but its owner can read is refused before it is read, and so is a cookie without a
 * session token or an origin that is neither https nor the local stack. Errors never quote the file.
 */
export function readSession(file: string): Session {
  if (file === '' || (statSync(file).mode & 0o077) !== 0) throw new Error('private_otp_session_file_required')
  const saved = Option.getOrUndefined(decodeSession(readFileSync(file, 'utf8')))
  if (saved === undefined || !saved.cookie.includes('session_token=')) throw new Error('session_file_shape')
  const url = URL.parse(saved.origin)
  const local = url?.protocol === 'http:' && url.hostname === 'localhost'
  if (url === null || (url.protocol !== 'https:' && !local) || url.origin !== saved.origin)
    throw new Error('session_origin_must_be_https')
  return saved
}
