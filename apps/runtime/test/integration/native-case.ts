import * as Schema from 'effect/Schema'
import { expect } from 'vitest'

/** One case of the native suite: a title (with its `[canary]` tag) and what it runs against the worker at `base`. */
export interface NativeCase {
  readonly title: string
  /** Set for the second process of the reconstruction proof, which reads what the first one left. */
  readonly secondProcess?: true
  readonly run: (base: string) => Promise<void>
}

/** Workerd eviction closes its HTTP connection; never reuse an earlier request's socket. */
export const nativeFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}

/**
 * Stops the object `name` through its eviction probe (the probe agent's `evict` by default); the request may be cut off
 * with it, so its answer is not read.
 */
export const evict = (base: string, name: string, probe = 'evict'): Promise<void> =>
  nativeFetch(`${base}/probe/${probe}?name=${name}`).then(
    () => undefined,
    () => undefined,
  )

/** A fresh agent's name for one probe: its own Durable Object, apart from every other case's. */
export const freshName = (probe: string) => `${probe}-${crypto.randomUUID()}`

/**
 * Probe `probe` of the native worker at `base` on the agent `name` (a fresh one by default), answered 200 and decoded
 * by `schema`. `query` adds search parameters (an operation id).
 */
export async function probeOf<A>(
  base: string,
  probe: string,
  schema: Schema.Decoder<A>,
  name = freshName(probe),
  query: Readonly<Record<string, string>> = {},
): Promise<A> {
  const search = new URLSearchParams({ name, ...query })
  const response = await nativeFetch(`${base}/probe/${probe}?${search.toString()}`)
  const text = await response.text()
  expect(response.status, text).toBe(200)
  const json: unknown = JSON.parse(text)
  return Schema.decodeUnknownPromise(schema)(json)
}

/** A case that runs one probe on a fresh agent and checks its decoded answer. */
export const probeCase = <A>(
  title: string,
  probe: string,
  schema: Schema.Decoder<A>,
  check: (result: A) => void,
): NativeCase => ({ title, run: async (base) => check(await probeOf(base, probe, schema)) })

/** As `probeCase`, for a probe whose answer is checked as it is (with `toMatchObject` and the like). */
export const matchCase = (title: string, probe: string, check: (result: unknown) => void): NativeCase =>
  probeCase(title, probe, Schema.Unknown, check)

/**
 * How this vitest process takes part in the reconstruction proof: alone (`same-process`), or as the first (`write`) or
 * second (`read`) of two processes over one retained stage.
 */
export type Phase = 'same-process' | 'write' | 'read'
