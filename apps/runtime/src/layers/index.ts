import * as Layer from 'effect/Layer'
import type { AgentInputs } from '../runtime/input.ts'
import { AppRegistryLive, AppsLive } from './apps.ts'
import { ConversationLive } from './conversation.ts'
import { CoreLive, MigrationsLive } from './core.ts'
import { DelegationLive, HelperExecutionLive } from './delegation.ts'
import { HttpLive } from './http.ts'
import {
  ActivateMemoriesLive,
  CheapModelsLive,
  KnowledgeLive,
  MemoryEngineLive,
  SkillsLive,
  TranscriptsLive,
} from './knowledge.ts'
import { ChatsStep, ConversationsStep, MovesStep } from './legacy.ts'
import { McpEventsLive, McpHostLive, McpLive, ProfilesLive, RetoolLive } from './mcp.ts'
import { ObservabilityLive } from './observability.ts'
import { ChannelLive, ModelBudgetLive, RoutineUsageLive, RoutinesLive } from './routines.ts'

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
    then(MigrationsLive), // 1 core
    then(McpHostLive), // 2 mcp: endpoint bindings, cipher, held calls recovered, the host
    then(CheapModelsLive), // 3 knowledge
    then(ChatsStep), // 4 conversation (legacy until lane C)
    then(MemoryEngineLive), // 5 knowledge
    then(ProfilesLive), // 6 mcp
    then(HelperExecutionLive), // 7 delegation: await
    then(RetoolLive), // 8 mcp: await
    then(RoutineUsageLive), // 9 routines: await
    then(ConversationsStep), // 10 conversation: main registered (legacy until lane C)
    then(AppRegistryLive), // 11 apps
    then(TranscriptsLive), // 12 knowledge
    then(MovesStep), // 13 conversation: reconcile, not awaited (legacy until lane C)
    then(ActivateMemoriesLive), // 14 knowledge: await
    then(SkillsLive), // 15 knowledge
    then(ChannelLive), // 16 routines
    then(McpEventsLive), // 17 mcp: await the hook token, then the consumers
  )

/**
 * Every service of one agent, built once per Durable Object (agent.ts): the start (above), the plan, model budget and
 * model picker (a send's admission reads them), then each lane's layer in turn, each built after and over everything
 * before it.
 */
export const AgentLive = (input: AgentInputs) =>
  start(input).pipe(
    then(ModelBudgetLive),
    then(ConversationLive),
    then(DelegationLive),
    then(McpLive),
    then(KnowledgeLive),
    then(RoutinesLive),
    then(ObservabilityLive),
    then(AppsLive),
    then(HttpLive),
  )

/** Every service a program may require, derived from the layers so no lane edits a shared union. */
export type AgentServices = Layer.Success<ReturnType<typeof AgentLive>>
