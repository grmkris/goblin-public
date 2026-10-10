import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements, cachedPolicy } from '../billing/gates.ts'
import { epochSeconds } from '../clock.ts'
import { ResidentInactive } from '../http/errors.ts'
import {
  type Approvals,
  type Events,
  type McpConnections,
  type McpGrants,
  type McpServers,
  Resident,
} from '../mcp/service.ts'
import { flowAnalytics } from '../observability/ae.ts'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { LoggerLive } from '../observability/logger.ts'
import { ReporterLive } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { PiSessions } from '../pi/sessions.ts'
import { enableResident, renewResident, residentStatus, revokeResident } from '../resident.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { flowRunEvent } from '../telemetry/events.ts'
import type { Apps } from '../apps/service.ts'
import type { ProfilesInstance } from '../capabilities/profiles.ts'
import type { Channel } from '../channel/service.ts'
import type { ChatsInstance } from '../chats/directory.ts'
import type { MovesInstance } from '../chats/mover.ts'
import type { Cipher } from '../mcp/cipher.ts'
import type { MemoriesInstance } from '../memory/memory.ts'
import type { CheapModels } from '../memory/model.ts'
import type { RoutineUsage } from '../routines/service.ts'
import type { Learner, Skills } from '../skills/service.ts'

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
 * The account's plan as the agent checks it, an active one kept a minute (`cachedPolicy`): for the bridge, the owner
 * gate, the MCP host and Events, and every program that reads `Entitlements` when it runs.
 */
export const EntitlementsLive: Layer.Layer<Entitlements, never, AgentInput> = Layer.effect(
  Entitlements,
  AgentInput.use((input) => cachedPolicy(input.entitlements)),
)

/** Resident authority over its row in the agent's database: no state of its own. */
export const ResidentLive: Layer.Layer<Resident, never, Db> = Layer.effect(
  Resident,
  Effect.gen(function* () {
    const db = yield* Db
    const status = Effect.fn('Resident.status')(function* () {
      const now = yield* epochSeconds
      return yield* Effect.sync(() => residentStatus(db, now))
    })
    return Resident.of({
      status,
      renew: Effect.fn('Resident.renew')(function* () {
        const now = yield* epochSeconds
        yield* Effect.sync(() => renewResident(db, now))
      }),
      revoke: Effect.fn('Resident.revoke')(function* () {
        const now = yield* epochSeconds
        return yield* Effect.sync(() => {
          revokeResident(db, now)
          return residentStatus(db, now)
        })
      }),
      enable: Effect.fn('Resident.enable')(function* () {
        const now = yield* epochSeconds
        return yield* Effect.sync(() => {
          enableResident(db, now)
          return residentStatus(db, now)
        })
      }),
      require: Effect.fn('Resident.require')(function* () {
        const { state } = yield* status()
        if (state !== 'active') return yield* new ResidentInactive({ state })
      }),
    })
  }),
)

/**
 * What every program can read: the instance's input, its database, the change bus, Pi, the per-key lock, single
 * flights, flow events, the plan the agent keeps and resident authority. The content-free logger and failure reporter
 * (observability/) replace Effect's defaults for everything the runtime runs. None of them starts anything.
 */
export const CoreLive = (
  input: AgentInputs,
): Layer.Layer<
  AgentInput | Db | Changes | PiSessions | KeyedLock | SingleFlight | FlowEvents | Entitlements | Resident
> =>
  ResidentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Db.layer,
        Changes.layer,
        PiSessions.layer,
        KeyedLock.layer,
        SingleFlight.layer,
        FlowsLive,
        EntitlementsLive,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(Layer.succeed(AgentInput, input), LoggerLive, ReporterLive)),
  )

/** What the start's steps provide (layers/index.ts). */
type StartServices =
  | ChatsInstance
  | MovesInstance
  | McpConnections
  | McpServers
  | McpGrants
  | Approvals
  | Cipher
  | ProfilesInstance
  | Events
  | CheapModels
  | MemoriesInstance
  | Skills
  | Learner
  | RoutineUsage
  | Channel
  | Apps

/**
 * What an area's layer after the start may require: the core services and what the start made. It also sees the
 * area layers before it in `layers/index.ts`.
 */
export type FoundationServices = Layer.Success<ReturnType<typeof CoreLive>> | StartServices
