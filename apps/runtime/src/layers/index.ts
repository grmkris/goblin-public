import * as Layer from 'effect/Layer'
import { AgentHttp } from '../http/api/server.ts'
import { Inspection } from '../inspect/service.ts'
import type { AgentInputs } from '../runtime/input.ts'
import { AppRegistryLive, AppsLive } from './apps.ts'
import { ModelBudgetLive } from './budget.ts'
import { CapabilitiesLive, RetoolLive } from './capabilities.ts'
import { ConversationLive, PrimaryChatLive } from './conversation.ts'
import { CoreLive } from './core.ts'
import { DecisionsLive } from './decisions.ts'
import { DelegationLive, HelperExecutionLive } from './delegation.ts'
import { ActivateMemoriesLive, CheapModelsLive, KnowledgeLive } from './knowledge.ts'
import { McpEventsLive, McpHostLive } from './mcp.ts'
import { ChannelLive, RoutineRunsLive, RoutinesLive } from './routines.ts'
import { SkillsLive } from './skills.ts'
import { WorkspaceLive } from '../workspace/live.ts'

/** `step`, built after and over everything `built` provides; the result provides both. */
const then =
  <A, E, R>(step: Layer.Layer<A, E, R>) =>
  <A0, E0, R0>(built: Layer.Layer<A0, E0, R0>) =>
    Layer.provideMerge(step, built)

/**
 * The agent's start: the core services (step 1, `layers/core.ts`), then each step in its one fixed order (the boot
 * contract). A step is a layer built after and over every step before it, so its await holds up the steps after it.
 *
 * 2. The MCP host. Awaits the credential cipher's key, which every stored credential and held call is sealed with;
 *    each server's endpoint binding is checked and the held calls a restart cut off are recovered before anything
 *    can connect or decide one.
 * 3. The cheap models, which the memories (9) and the skill learner (10) are built over.
 * 4. Helper execution. Awaits Pi: every registered helper goes on with the execution extensions the agent has now,
 *    also after the object was rebuilt.
 * 5. Retooling. Awaits Pi: every conversation's stored tool filter is applied to Pi again, once (a marker records it),
 *    so a filter stored before the delegation tools changed names them as they are now.
 * 6. Routine runs. Awaits the usage projection's subscription to Pi's commits, made after a snapshot of each live
 *    run, so nothing after it can commit to Pi unseen.
 * 7. Main registered, before anything reads the chat directory for it.
 * 8. The App registry, which follows `conversations.changed` and `agent-apps.changed` from the first write on.
 * 9. Memories. Awaits every Topic Conversation without memory being given it (a fresh agent's Personal, registered
 *    at 7, or a Topic whose activation a crash cut short).
 * 10. Skills and the learner, over the host's connections.
 * 11. The Telegram channel.
 * 12. Events. Awaits the hook token, then registers the Telegram and skills consumers (10, 11) before any delivery
 *     can reach the engine.
 */
const start = (input: AgentInputs) =>
  CoreLive(input).pipe(
    then(McpHostLive), // 2
    then(CheapModelsLive), // 3
    then(HelperExecutionLive), // 4
    then(RetoolLive), // 5
    then(RoutineRunsLive), // 6
    then(PrimaryChatLive), // 7
    then(AppRegistryLive), // 8
    then(ActivateMemoriesLive), // 9
    then(SkillsLive), // 10
    then(ChannelLive), // 11
    then(McpEventsLive), // 12
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
    then(Inspection.layer),
    then(AppsLive),
    then(DecisionsLive),
    then(WorkspaceLive),
    then(AgentHttp.layer),
  )

/** Every service a program may require, derived from the layers so no area edits a shared union. */
export type AgentServices = Layer.Success<ReturnType<typeof AgentLive>>
