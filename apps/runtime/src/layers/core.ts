import * as Layer from 'effect/Layer'
import { PiSessions } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import type { LegacyLive } from './legacy.ts'

/** What every program can read: the instance's input, its database, the change bus and Pi. None starts anything. */
export const CoreLive = (input: AgentInputs): Layer.Layer<AgentInput | Db | Changes | PiSessions> =>
  Layer.mergeAll(Db.layer, Changes.layer, PiSessions.layer).pipe(Layer.provideMerge(Layer.succeed(AgentInput, input)))

/**
 * What a lane's layer may require: the core services and, until each moves into its lane, the legacy ones. A lane
 * layer also sees the lanes below it in `layers/index.ts`.
 */
export type FoundationServices = Layer.Success<ReturnType<typeof CoreLive>> | Layer.Success<typeof LegacyLive>
