import * as Layer from 'effect/Layer'
import { AgentHttp } from '../http/api/server.ts'
import type { AgentInputs } from '../runtime/input.ts'
import { AppRegistryLive, AppsLive } from './apps.ts'
import { ModelBudgetLive } from './budget.ts'
import { CapabilitiesLive, RetoolLive } from './capabilities.ts'
import { ChatDirectoryLive, ConversationLive, PrimaryChatLive } from './conversation.ts'
import { CoreLive } from './core.ts'
import { DelegationLive, HelperExecutionLive } from './delegation.ts'
import { ActivateMemoriesLive, CheapModelsLive, KnowledgeLive } from './knowledge.ts'
import { McpEventsLive, McpHostLive } from './mcp.ts'
import { ObservabilityLive } from './observability.ts'
import { ChannelLive, RoutineRunsLive, RoutinesLive } from './routines.ts'
import { SkillsLive } from './skills.ts'
import { WorkspaceLive } from '../workspace/live.ts'

/** `step`, built after and over everything `built` provides; the result provides both. */
const then =
  <A, E, R>(step: Layer.Layer<A, E, R>) =>
  <A0, E0, R0>(built: Layer.Layer<A0, E0, R0>) =>
    Layer.provideMerge(step, built)

/**
 * The agent's start over the core services, step by step in its one fixed order (the boot contract): each step is a
 * layer built after and over every step before it, so each await holds up the steps after it.
 */
const start = (input: AgentInputs) =>
  CoreLive(input).pipe(
    then(McpHostLive), // 2 mcp: endpoint bindings, cipher, held calls recovered, the host and its services
    then(CheapModelsLive), // 3 knowledge
    then(ChatDirectoryLive), // 4 conversation
    then(HelperExecutionLive), // 7 delegation: await
    then(RetoolLive), // 8 capabilities: await
    then(RoutineRunsLive), // 9 routines: runs and their usage projection, await
    then(PrimaryChatLive), // 10 conversation: main registered
    then(AppRegistryLive), // 11 apps
    then(ActivateMemoriesLive), // 14 knowledge: await
    then(SkillsLive), // 15 skills
    then(ChannelLive), // 16 routines
    then(McpEventsLive), // 17 mcp: await the hook token, then the consumers
  )

/**
 * Every service of one agent, built once per Durable Object (agent.ts): the start (above), the model budget and model
 * picker (a send's admission reads them, with the plan the core keeps), then each area's layer in turn, each built
 * after and over everything before it.
 */
export const AgentLive = (input: AgentInputs) =>
  start(input).pipe(
    then(ModelBudgetLive),
    then(ConversationLive),
    then(CapabilitiesLive),
    then(KnowledgeLive),
    then(DelegationLive),
    then(RoutinesLive),
    then(ObservabilityLive),
    then(AppsLive),
    then(WorkspaceLive),
    then(AgentHttp.layer),
  )

/** Every service a program may require, derived from the layers so no lane edits a shared union. */
export type AgentServices = Layer.Success<ReturnType<typeof AgentLive>>
