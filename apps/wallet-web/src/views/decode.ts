// Tool results arrive from a server we trust but over a channel we do not own: decode, never cast.
import type { CallToolResult } from '@modelcontextprotocol/client'
import { LimitView, Operation, SpendResult, WalletStatusResult } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** The structured content of a result, or the first text block read as JSON when the host dropped the structure. */
export function payloadOf(result: CallToolResult | undefined): unknown {
  if (result === undefined) return undefined
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.find((block) => block.type === 'text')
  if (text === undefined || text.type !== 'text') return undefined
  try {
    return JSON.parse(text.text)
  } catch {
    // expected: a text block that is not JSON simply carries no payload
    return undefined
  }
}

const decodeStatus = Schema.decodeUnknownOption(WalletStatusResult)
const decodeSpend = Schema.decodeUnknownOption(SpendResult)

export const statusOf = (result: CallToolResult | undefined): WalletStatusResult | undefined =>
  Option.getOrUndefined(decodeStatus(payloadOf(result)))

export const spendOf = (result: CallToolResult | undefined): SpendResult | undefined =>
  Option.getOrUndefined(decodeSpend(payloadOf(result)))

const decodeRecent = Schema.decodeUnknownOption(Schema.Array(Operation))

/** The few latest operations a result may carry beside the status (`recent`); anything malformed reads as none. */
export function recentOf(result: CallToolResult | undefined): readonly (typeof Operation.Type)[] {
  const payload = payloadOf(result)
  if (typeof payload !== 'object' || payload === null || !('recent' in payload)) return []
  return Option.getOrElse(decodeRecent(payload.recent), () => [])
}

const decodeLimits = Schema.decodeUnknownOption(Schema.Array(LimitView))

/** What a spend result may carry beside the operation: where the owner approves it, and the limits as they now stand. */
export function receiptExtrasOf(result: CallToolResult | undefined): {
  readonly approveUrl: string | undefined
  readonly limits: readonly (typeof LimitView.Type)[]
} {
  const payload = payloadOf(result)
  if (typeof payload !== 'object' || payload === null) return { approveUrl: undefined, limits: [] }
  const url = 'approveUrl' in payload && typeof payload.approveUrl === 'string' ? payload.approveUrl : undefined
  const limits = 'limits' in payload ? Option.getOrElse(decodeLimits(payload.limits), () => []) : []
  return { approveUrl: url?.startsWith('https://') === true ? url : undefined, limits }
}
