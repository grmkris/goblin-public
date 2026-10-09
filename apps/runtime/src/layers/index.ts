import * as Layer from 'effect/Layer'
import type { AgentInputs } from '../runtime/input.ts'
import { AppsLive } from './apps.ts'
import { ConversationLive } from './conversation.ts'
import { CoreLive } from './core.ts'
import { DelegationLive } from './delegation.ts'
import { HttpLive } from './http.ts'
import { KnowledgeLive } from './knowledge.ts'
import {
  ActivateMemoriesStep,
  AppsStep,
  BudgetStep,
  ChannelStep,
  ChatsStep,
  ConversationsStep,
  DelegationStep,
  HelperExecutionStep,
  MemoryStep,
  MigrationsStep,
  MovesStep,
  RestStep,
  RoutinesStep,
  SkillsStep,
  TranscriptsStep,
} from './legacy.ts'
import { McpEventsLive, McpHostLive, McpLive, ProfilesLive, RetoolLive } from './mcp.ts'
import { ObservabilityLive } from './observability.ts'
import { ModelBudgetLive, RoutinesLive } from './routines.ts'

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
    then(MigrationsStep),
    then(McpHostLive),
    then(BudgetStep),
    then(ChatsStep),
    then(MemoryStep),
    then(ProfilesLive),
    then(HelperExecutionStep),
    then(RetoolLive),
    then(RoutinesStep),
    then(ConversationsStep),
    then(AppsStep),
    then(DelegationStep),
    then(TranscriptsStep),
    then(MovesStep),
    then(ActivateMemoriesStep),
    then(SkillsStep),
    then(ChannelStep),
    then(McpEventsLive),
    then(RestStep),
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
