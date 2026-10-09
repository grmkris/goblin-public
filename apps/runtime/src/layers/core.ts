import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { LoggerLive } from '../observability/logger.ts'
import { ReporterLive } from '../observability/report.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { flowRunEvent } from '../telemetry/events.ts'
import type { LegacyLive } from './legacy.ts'

/** Conversation flows go to the agent's run ledger and its log line (ADR 0024); lane O adds Analytics Engine. */
const FlowsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { telemetry } = yield* AgentInput
    return FlowEvents.layerWith((event) =>
      Effect.map(Clock.currentTimeMillis, (at) => telemetry.record(flowRunEvent(event, telemetry.id('flow', at), at))),
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

/**
 * What a lane's layer may require: the core services and, until each moves into its lane, the legacy ones. A lane
 * layer also sees the lanes below it in `layers/index.ts`.
 */
export type FoundationServices = Layer.Success<ReturnType<typeof CoreLive>> | Layer.Success<typeof LegacyLive>
