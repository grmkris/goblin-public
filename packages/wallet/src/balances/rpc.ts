import * as Data from 'effect/Data'

/** A minimal JSON-RPC client over `fetch`, shared by the rails. No viem client, so it runs anywhere `fetch` does. */

export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

export class JsonRpcError extends Data.TaggedError('JsonRpcError')<{
  readonly message: string
  readonly code: number | undefined
}> {
  constructor(method: string, message: string, code?: number) {
    super({ message: `${method}: ${message}`, code })
  }
}

interface RpcEnvelope {
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

const isEnvelope = (value: unknown): value is RpcEnvelope => typeof value === 'object' && value !== null

/** Public RPCs rate-limit Cloudflare's shared egress (429); a busy node is asked again, briefly. */
const RETRY_STATUSES = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [250, 750]

/**
 * A JSON-RPC caller for one endpoint. `fetchFn` is injectable so tests run against a fake node. A 429 or 5xx is
 * retried twice: the same request, even a signed transaction, is safe to send again.
 */
export const httpJsonRpc = (url: string, fetchFn: typeof fetch = fetch, delays = RETRY_DELAYS_MS): JsonRpc => {
  let id = 0
  return async (method, params) => {
    id += 1
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const post = () => fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    let response = await post()
    for (const delay of delays) {
      if (!RETRY_STATUSES.has(response.status)) break
      await new Promise((resolve) => setTimeout(resolve, delay))
      response = await post()
    }
    if (!response.ok) throw new JsonRpcError(method, `HTTP ${response.status}`)
    const answer: unknown = await response.json()
    if (!isEnvelope(answer)) throw new JsonRpcError(method, 'malformed response')
    if (answer.error) throw new JsonRpcError(method, answer.error.message ?? 'error', answer.error.code)
    return answer.result
  }
}

/** Parses a JSON-RPC quantity ("0x1f") to a bigint; refuses anything else. */
export const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(value))
    throw new JsonRpcError('quantity', 'not a hex quantity')
  return BigInt(value)
}

/** A JSON object field of an RPC result, or undefined when the result is not an object. */
export const field = (value: unknown, name: string): unknown => (isRecord(value) ? value[name] : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export type TxStatus = 'success' | 'reverted' | 'pending'

export interface WaitOptions {
  readonly attempts?: number
  readonly intervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Polls for a transaction receipt; `pending` when none arrived in time (the caller treats that as uncertain). */
export const waitForReceipt = async (rpc: JsonRpc, hash: string, options: WaitOptions = {}): Promise<TxStatus> => {
  const sleep = options.sleep ?? realSleep
  for (let attempt = 0; attempt < (options.attempts ?? 20); attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash])
    if (isRecord(receipt)) return receipt['status'] === '0x1' ? 'success' : 'reverted'
    await sleep(options.intervalMs ?? 1500)
  }
  return 'pending'
}
