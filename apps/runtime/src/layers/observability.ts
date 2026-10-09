import * as Layer from 'effect/Layer'
import type { Conversations } from '../chats/service.ts'
import { Inspection } from '../inspect/service.ts'
import type { AgentInput } from '../runtime/input.ts'
import type { Db } from '../runtime/db.ts'

/**
 * Lane O's services: inspection over the run ledger, the registered chats (the conversation lane's `Conversations`)
 * and Pi. Telemetry itself is in the instance's input, and flows are recorded by the core layer's `FlowEvents`.
 */
export const ObservabilityLive: Layer.Layer<Inspection, never, Db | Conversations | AgentInput> = Layer.mergeAll(
  Inspection.layer,
)
