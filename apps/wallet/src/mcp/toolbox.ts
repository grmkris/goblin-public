import type * as Effect from 'effect/Effect'
import type { WalletResult } from '../runtime.ts'
import type { WalletFailure } from '../services/errors.ts'
import type { WalletServices } from '../services/index.ts'

/** What a tool needs from the request it serves: a way to run a wallet program, and who is calling. */
export interface Toolbox {
  readonly run: <A>(program: Effect.Effect<A, WalletFailure, WalletServices>) => Promise<WalletResult<A>>
  /** `modern` clients can be asked for input mid-call (URL elicitation); `legacy` ones are told in the result. */
  readonly era: 'legacy' | 'modern'
  /** The MCP client's name as the owner knows it, for the approval page. */
  readonly client: string
  /** The OAuth scopes the connection holds: `wallet:read`, `wallet:spend`. */
  readonly scopes: readonly string[]
}
