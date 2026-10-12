/** A minimal JSON-RPC client over `fetch`, shared by the rails. No viem client, so it runs anywhere `fetch` does. */

export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

export class JsonRpcError extends Error {
  readonly code: number | undefined
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`)
    this.name = 'JsonRpcError'
    this.code = code
  }
}

interface RpcEnvelope {
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

const isEnvelope = (value: unknown): value is RpcEnvelope => typeof value === 'object' && value !== null

/** A JSON-RPC caller for one endpoint. `fetchFn` is injectable so tests run against a fake node. */
export const httpJsonRpc = (url: string, fetchFn: typeof fetch = fetch): JsonRpc => {
  let id = 0
  return async (method, params) => {
    id += 1
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    if (!response.ok) throw new JsonRpcError(method, `HTTP ${response.status}`)
    const body: unknown = await response.json()
    if (!isEnvelope(body)) throw new JsonRpcError(method, 'malformed response')
    if (body.error) throw new JsonRpcError(method, body.error.message ?? 'error', body.error.code)
    return body.result
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
