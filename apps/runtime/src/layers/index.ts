import * as Layer from 'effect/Layer'
import type { AgentInputs } from '../runtime/input.ts'
import { AppsLive } from './apps.ts'
import { ConversationLive } from './conversation.ts'
import { CoreLive } from './core.ts'
import { DelegationLive } from './delegation.ts'
import { HttpLive } from './http.ts'
import { KnowledgeLive } from './knowledge.ts'
import { LegacyLive } from './legacy.ts'
import { McpLive } from './mcp.ts'
import { ObservabilityLive } from './observability.ts'
import { ModelBudgetLive, RoutinesLive } from './routines.ts'

/**
 * Every service of one agent, built once per Durable Object (agent.ts): the core services, the legacy start in its
 * order (layers/legacy.ts), the plan, model budget and model picker (a send's admission reads them), then each lane's
 * layer in turn, each built after and over everything before it.
 */
export const AgentLive = (input: AgentInputs) => {
  const foundation = Layer.provideMerge(LegacyLive, CoreLive(input))
  const budget = Layer.provideMerge(ModelBudgetLive, foundation)
  const conversation = Layer.provideMerge(ConversationLive, budget)
  const delegation = Layer.provideMerge(DelegationLive, conversation)
  const mcp = Layer.provideMerge(McpLive, delegation)
  const knowledge = Layer.provideMerge(KnowledgeLive, mcp)
  const routines = Layer.provideMerge(RoutinesLive, knowledge)
  const observability = Layer.provideMerge(ObservabilityLive, routines)
  const apps = Layer.provideMerge(AppsLive, observability)
  return Layer.provideMerge(HttpLive, apps)
}

/** Every service a program may require, derived from the layers so no lane edits a shared union. */
export type AgentServices = Layer.Success<ReturnType<typeof AgentLive>>
