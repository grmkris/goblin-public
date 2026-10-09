import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { RuntimeEnv } from '../env.ts'

/**
 * Conversation flows across every agent, for the operator (ADR 0037): one Workers Analytics Engine point per operation,
 * keyed by a hashed agent id. A point holds closed classes, counts and timings only; never a chat or operation id, and
 * never content (ADR 0024). Each agent's own flows, with their ids, stay in its run ledger.
 */

/** The HKDF info of the current agent hash. A new label gives every agent a new, unlinkable hash. */
export const AGENT_HASH_INFO = 'goblin/flows/agent-v1'
/** Hex characters of the agent hash: 64 bits, enough to keep agents apart in aggregates. */
const HASH_LENGTH = 16
/** Operations remembered per agent object to keep to one point each; an older one could be written again. */
const REMEMBERED = 1000

/** A step of the flow point's making failed: deriving the agent hash, or writing the point. Safe to log. */
export class FlowPointFailure extends Schema.TaggedError<FlowPointFailure>()('FlowPointFailure', {
  step: Schema.Literals(['hash', 'write']),
  cause: Schema.Defect(),
}) {}

const bytesOfBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.trim()), (char) => char.charCodeAt(0))
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * The agent's id in Analytics Engine: HMAC-SHA-256 of its user id under a key derived with HKDF-SHA-256 from
 * `CREDENTIAL_KEY` and `info`, as 16 hex characters. Stable for one key and label; the user id cannot be read back.
 */
export const agentHash = (
  credentialKey: string,
  userId: string,
  info: string = AGENT_HASH_INFO,
): Effect.Effect<string, FlowPointFailure> =>
  Effect.tryPromise({
    try: async () => {
      const secret = await crypto.subtle.importKey('raw', bytesOfBase64(credentialKey), 'HKDF', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(info) },
        secret,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign'],
      )
      const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId))
      return hex(new Uint8Array(mac)).slice(0, HASH_LENGTH)
    },
    catch: (cause) => new FlowPointFailure({ step: 'hash', cause }),
  })

/** Where a point was written from: the stage and the build. */
export type PointContext = { readonly stage: string; readonly build: string }

/**
 * A flow step as one point:
 * - `indexes: [agentHash]`
 * - `blobs: [flow, via, actor, origin, status, errorType, stage, build, personaOrder]`
 * - `doubles: [1, count, ms, depth]`, where `depth` is 1 for a step another operation caused, else 0.
 *
 * `origin` is the operation receipt's (owner, client, telegram, …) and stays empty until flow steps carry it.
 */
export const flowPoint = (event: FlowEvent, agent: string, context: PointContext): AnalyticsEngineDataPoint => ({
  indexes: [agent],
  blobs: [
    event.flow,
    event.via,
    event.actor,
    '',
    event.status,
    event.errorType ?? '',
    context.stage,
    context.build,
    event.personaOrder ?? '',
  ],
  doubles: [1, event.count ?? 0, event.ms ?? 0, event.parentOperation === undefined ? 0 : 1],
})

/** Writes a flow step's point, as `flowAnalytics` returns it. */
export type FlowPointWriter = (event: FlowEvent) => Effect.Effect<void, FlowPointFailure>

/** Each operation's first step as a point to `dataset`; `agent` hashes once, the first time a point needs it. */
function pointWriter(
  dataset: AnalyticsEngineDataset,
  agent: Effect.Effect<string, FlowPointFailure>,
  context: PointContext,
): FlowPointWriter {
  const written = new Set<string>()
  const firstOf = (operationId: string | undefined): boolean => {
    if (operationId === undefined) return true
    if (written.has(operationId)) return false
    written.add(operationId)
    const [oldest] = written
    if (written.size > REMEMBERED && oldest !== undefined) written.delete(oldest)
    return true
  }
  return (event) =>
    firstOf(event.operationId)
      ? Effect.flatMap(agent, (hash) =>
          Effect.try({
            try: () => dataset.writeDataPoint(flowPoint(event, hash, context)),
            catch: (cause) => new FlowPointFailure({ step: 'write', cause }),
          }),
        )
      : Effect.void
}

/**
 * The Analytics Engine sink of one agent's flow steps: each operation's first step becomes a point, later steps of the
 * same operation are not written again, and a step without an operation id is written as it comes. Without the
 * `FLOWS` binding (tests, a stage without it) it writes nothing.
 */
export const flowAnalytics = (
  env: Pick<RuntimeEnv, 'FLOWS' | 'CREDENTIAL_KEY' | 'STAGE'>,
  userId: string,
  build = '',
): Effect.Effect<FlowPointWriter> => {
  const dataset = env.FLOWS
  if (dataset === undefined) return Effect.succeed(() => Effect.void)
  const context = { stage: env.STAGE ?? 'local', build }
  return Effect.map(Effect.cached(agentHash(env.CREDENTIAL_KEY, userId)), (agent) =>
    pointWriter(dataset, agent, context),
  )
}
