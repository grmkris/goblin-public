import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { flowAnalytics } from '../observability/ae.ts'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { LoggerLive } from '../observability/logger.ts'
import { ReporterLive } from '../observability/report.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { flowRunEvent } from '../telemetry/events.ts'
import type { ProfilesInstance } from '../capabilities/profiles.ts'
import type { Channel } from '../channel/service.ts'
import type { Cipher } from '../mcp/cipher.ts'
import type { McpHostInstance } from '../mcp/host.ts'
import type { Events } from '../mcp/service.ts'
import type { MemoriesInstance } from '../memory/memory.ts'
import type { CheapModels } from '../memory/model.ts'
import type { TranscriptsInstance } from '../retrieval/index.ts'
import type { RoutineUsage } from '../routines/service.ts'
import type { Learner, Skills } from '../skills/service.ts'
import type { LegacyServices } from './legacy.ts'

/**
 * Conversation flows go to the agent's run ledger and its log line (ADR 0024), then, one point per operation with a
 * hashed agent id, to Analytics Engine for the operator (observability/ae.ts, ADR 0037).
 */
const FlowsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { telemetry, env, userId } = yield* AgentInput
    const analytics = yield* flowAnalytics(env, userId)
    return FlowEvents.layerWith((event) =>
      Effect.map(Clock.currentTimeMillis, (at) =>
        telemetry.record(flowRunEvent(event, telemetry.id('flow', at), at)),
      ).pipe(Effect.andThen(analytics(event))),
    )
  }),
)

/**
 * What every program can read: the instance's input, its database, the change bus, Pi, the per-key lock and flow
 * events. The content-free logger and failure reporter (observability/) replace Effect's defaults for everything the
 * runtime runs. None of them starts anything.
 */
export const CoreLive = (
  input: AgentInputs,
): Layer.Layer<AgentInput | Db | Changes | PiSessions | KeyedLock | FlowEvents> =>
  Layer.mergeAll(Db.layer, Changes.layer, PiSessions.layer, KeyedLock.layer, FlowsLive).pipe(
    Layer.provideMerge(Layer.mergeAll(Layer.succeed(AgentInput, input), LoggerLive, ReporterLive)),
  )

/** What the start's steps outside the legacy start provide (layers/index.ts). */
type StartServices =
  | McpHostInstance
  | Cipher
  | ProfilesInstance
  | Events
  | CheapModels
  | MemoriesInstance
  | TranscriptsInstance
  | Skills
  | Learner
  | RoutineUsage
  | Channel

/**
 * What a lane's layer may require: the core services and what the start made (the legacy steps' until each moves into
 * its lane). A lane layer also sees the lanes before it in `layers/index.ts`.
 */
export type FoundationServices = Layer.Success<ReturnType<typeof CoreLive>> | StartServices | LegacyServices
