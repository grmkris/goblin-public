import * as Context from 'effect/Context'
import type { StopRuntime } from '../../agent-program.ts'

/**
 * What owner handlers still take from the Durable Object instance itself rather than from a service: what an archive
 * or a Stop reaches (Pi, the routine runner, the Persona turns asked in a chat). F-B's `AgentInput` is to hold it; the
 * agent provides this until the two are reconciled.
 */
export class AgentInstance extends Context.Service<AgentInstance, { readonly stopping: () => StopRuntime }>()(
  'goblin/http/AgentInstance',
) {}
