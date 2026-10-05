import {
  type ConversationId,
  type Extension,
  type Harness,
  LiveDoc,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
  configure,
  defineExtension,
  defineTask,
  defineTool,
  section,
} from '@earendil-works/pi-durable'
import { type Static, Type, type UserMessage } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import { Capabilities, Conversations, attempt, nowSecondsEffect } from '../services.ts'
import { capabilityOffResult } from './capabilities.ts'
import { BACKGROUND, conversationId } from './context.ts'
import type { RunProgram } from './resident-mcp.ts'
import {
  type Authorize,
  type Relay,
  type Subagent,
  Subagents,
  background,
  carriesRequest,
  liveRelays,
  quoted,
  relayTask,
} from './subagent-relay.ts'

/** The tool that starts subagents: what a conversation with subagents switched off has filtered out (ADR 0010). */
export const SUBAGENT_TOOL = 'subagent'

const GUIDE = [
  'The `subagent` tool starts subagents: helpers that work in the background, each in a conversation of its own, with',
  "the owner's tools and grants, and subagents of their own when a job splits. Use one for a job that takes a while or",
  "can be done apart from the conversation. A subagent's final answer comes back to you as a message starting",
  '`[from subagent <name>]`, once it and its own helpers are done: tell whoever you answer what matters in it. A',
  'subagent closes when its job is done; send to it again and it picks up where it left off.',
].join(' ')

const instructions = (name: string) =>
  [
    `You are the subagent "${name}", started to do one job. Do it and answer with the result: your answer is reported to`,
    'the agent that started you. Split a large job with subagents of your own; their answers come back to you, and',
    'yours is reported once they are done. You cannot ask the owner anything; if you need something from them, say so',
    'in your answer. The owner may also write to you directly: answer them the same way.',
  ].join(' ')

/**
 * Owns a subagent's conversation. It is a background task that finishes at once: the spawner's Stop and idle waits end
 * at a background task, so a subagent outlives the turn that started it.
 */
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'purrable.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})

const Args = Type.Object({
  action: Type.Union([Type.Literal('spawn'), Type.Literal('send'), Type.Literal('stop'), Type.Literal('status')]),
  name: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,40}$' })),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
})
type Args = Static<typeof Args>
type Api = ToolExecutionApi
type CallContext = Parameters<Api['commit']>[1]
type Agents = Readonly<Record<string, Subagent>>

const known = (agents: Agents, name: string) => (Object.hasOwn(agents, name) ? agents[name] : undefined)

/** The tool's answer; the details link the call to the subagent's conversation in the web. */
const reply = (text: string, name?: string, conversation?: ConversationId) => ({
  content: [{ type: 'text' as const, text }],
  ...(conversation === undefined || name === undefined ? {} : { details: { name, conversationId: conversation } }),
})

/** Who is working: one subagent, or every subagent this conversation started. */
async function status(api: Api, agents: Agents, name: string | undefined, context: CallContext) {
  const lines: string[] = []
  for (const each of name === undefined ? Object.keys(agents) : [name]) {
    const agent = known(agents, each)
    if (agent === undefined) continue
    const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
    lines.push(`${each}: ${busy ? 'working' : 'idle'}`)
  }
  return reply(lines.length === 0 ? 'No subagents.' : lines.join('\n'))
}

/**
 * Whether the spawner may send to a subagent: not one the owner closed, until they reopen it; one closed because its
 * job was done opens again for the next one.
 */
async function admit(run: RunProgram, agent: Subagent | undefined, name: string) {
  if (agent === undefined) return { reopened: false }
  const session = String(agent.conversationId)
  const view = await run(Conversations.use((conversations) => attempt(() => conversations.view(session))))
  if (view?.closedBy === 'owner')
    return { refused: `The owner closed ${name}; it takes no messages until they reopen it.`, reopened: false }
  if (view?.closedBy !== 'done') return { reopened: false }
  await run(
    Effect.gen(function* () {
      const conversations = yield* Conversations
      const now = yield* nowSecondsEffect
      yield* attempt(() => conversations.update(session, { closed: false }, now))
    }),
  )
  return { reopened: true }
}

/**
 * Stop: its current work and everything its own subagents are doing, through every level. What was on its way to it
 * stops first, so nothing reports the job cut short.
 */
async function stop(run: RunProgram, authorize: Authorize, api: Api, agent: Subagent, context: CallContext) {
  const session = String(agent.conversationId)
  const child = await api.conversation(agent.conversationId, context)
  await authorize(String(api.conversationId))
  await run(Conversations.use((conversations) => attempt(() => conversations.stopSubagents(session))))
  await child?.abort(context, { background: true })
}

type Deliver = (
  api: Api,
  action: 'spawn' | 'send',
  name: string,
  message: string,
  context: CallContext,
) => Promise<ReturnType<typeof reply>>

/**
 * The `subagent` tool: spawn, send, stop and status, behind the conversation's subagents switch. The caller's
 * authority is checked again after each read, before what it changes or answers.
 */
function subagentTool(run: RunProgram, authorize: Authorize, deliver: Deliver) {
  return defineTool({
    name: SUBAGENT_TOOL,
    description: [
      'Manage background subagents. spawn (name, message) starts one on a job; send (name, message) gives it another',
      'after its current answer; stop (name) aborts its current work and its own subagents; status (name, or none for',
      'all) says who is working. Final answers are reported back to you when they arrive.',
    ].join(' '),
    parameters: Args,
    // An interrupted call is not rerun: repeating a spawn or a stop could start or stop newer work. The model sees
    // the call was interrupted and can check with status.
    replay: 'unsafe',
    execute: async ({ action, name, message }: Args, api, context) => {
      const { agents } = (await api.snapshot(Subagents, api.conversationId, context)) ?? { agents: {} }
      await authorize(String(api.conversationId))
      if (action === 'status') {
        const result = await status(api, agents, name, context)
        await authorize(String(api.conversationId))
        return result
      }
      if (name === undefined) return reply(`${action} needs a name.`)
      const agent = known(agents, name)
      if (action !== 'spawn' && agent === undefined) return reply(`No subagent named ${name}.`)
      if (action === 'stop') {
        if (agent !== undefined) await stop(run, authorize, api, agent, context)
        return reply(`Stopped ${name}.`, name, agent?.conversationId)
      }
      if (message === undefined) return reply(`${action} needs a message.`)
      // Pi's tool filter hides this tool where subagents are switched off; a call that still arrives starts nothing.
      const scope = await run(Capabilities.useSync((capabilities) => capabilities.scope(String(api.conversationId))))
      if (!scope.subagents()) return capabilityOffResult({ kind: 'subagents' }, scope)
      return deliver(api, action, name, message, context)
    },
  })
}

/** The owner's message to a subagent, as `ownerSend` carries it. */
export type OwnerSend = {
  readonly subagent: string
  readonly spawner: string
  /** Its name in the registry, for a subagent its spawner no longer lists. */
  readonly title: string
  readonly content: UserMessage['content']
  readonly text: string
  readonly operationId: string
  /** Busy: the message steers its current work; idle: it starts a turn. */
  readonly busy: boolean
}

/** A relay in the spawner for the owner's message, once per operation: false when it is already on its way. */
async function ownerRelay(relay: Relay, pi: Harness, send: OwnerSend): Promise<boolean> {
  const spawner = await pi.conversation(conversationId(send.spawner), BACKGROUND)
  if (spawner === undefined) throw new Error(`Subagent ${send.subagent} has no spawner`)
  const subagent = conversationId(send.subagent)
  const created = await spawner.commit(async (tx) => {
    if ((await tx.submissionByRequest(subagent, send.operationId)) !== undefined) return false
    if ((await liveRelays(tx, spawner.id)).some((live) => carriesRequest(live, send.operationId))) return false
    const roster = await tx.doc(Subagents, spawner.id)
    const name = Object.entries(roster.agents).find(([, agent]) => agent.conversationId === subagent)?.[0]
    const input = {
      name: name ?? send.title,
      conversationId: subagent,
      content: send.content,
      origin: 'owner',
      whenBusy: send.busy ? 'steer' : 'followUp',
      quote: quoted(send.text),
      requestId: send.operationId,
    } as const
    await tx.createTask(relay, input, background)
    return true
  }, BACKGROUND)
  pi.resume()
  return created
}

export type SubagentKit = {
  readonly extension: Extension
  readonly tool: ToolRegistration
  /**
   * The owner's message to a subagent, carried like the spawner's by a relay in the spawner, so the answer reports up.
   * False when that operation is already on its way or delivered.
   */
  readonly ownerSend: (pi: Harness, send: OwnerSend) => Promise<boolean>
}

/**
 * Background subagents behind one `subagent` tool, after Pi Durable's example 23. A subagent is a conversation owned by
 * an anchor task of its spawner, given exactly `members(extension)`: the owner's tools and this extension again, so it
 * can start subagents of its own, at any depth (no `ask_user`). Each message goes through a relay task (`relayTask`),
 * and only the final answer comes back to the spawner. The registry lists each subagent under its spawner, so the
 * owner can open it.
 */
export function subagentsExtension(
  run: RunProgram,
  members: (self: Extension) => readonly Extension[],
  authorize: Authorize = async () => undefined,
): SubagentKit {
  const Relay = relayTask(run, authorize)

  /** A conversation for a new subagent, owned by an anchor of the spawner and given exactly its members. */
  async function spawn(tx: Tx, name: string): Promise<ConversationId> {
    const anchor = await tx.createTask(Anchor, null, background)
    // A task-owned conversation starts as a copy of the spawner's agent: its model and settings.
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })
    await configure(tx, child.id, { extensions: members(extension), instructions: instructions(name) })
    return child.id
  }

  /** spawn and send: one commit starts the subagent if new, and a relay for the message. */
  async function deliver(api: Api, action: 'spawn' | 'send', name: string, message: string, context: CallContext) {
    await authorize(String(api.conversationId))
    const roster = await api.snapshot(Subagents, api.conversationId, context)
    const admitted = await admit(run, roster === undefined ? undefined : known(roster.agents, name), name)
    if (admitted.refused !== undefined) return reply(admitted.refused)
    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId)
      const existing = known(state.agents, name)
      if (action === 'spawn' && existing !== undefined) return `${name} already exists; use send.`
      const child = existing?.conversationId ?? (await spawn(tx, name))
      state.agents[name] ??= { conversationId: child, reported: [] }
      const input = { name, conversationId: child, content: message, origin: 'spawner', whenBusy: 'followUp' } as const
      await tx.createTask(Relay, input, background)
      if (action === 'spawn') return `Started ${name}.`
      return admitted.reopened
        ? `Sent to ${name}; it had closed when its job was done and is open again.`
        : `Sent to ${name}.`
    }, context)
    const current = (await api.snapshot(Subagents, api.conversationId, context))?.agents[name]
    return reply(result, name, current?.conversationId)
  }

  const tool = subagentTool(run, authorize, deliver)
  const extension: Extension = defineExtension({
    name: 'purrable.subagents',
    // Only where the tool is offered: a conversation with subagents switched off has it filtered out.
    sections: [
      section('subagents', (input) =>
        input.agent.tools.some((offered) => offered.name === SUBAGENT_TOOL) ? GUIDE : undefined,
      ),
    ],
    tasks: [Anchor, Relay],
    tools: [tool],
  })
  return { extension, tool, ownerSend: (pi, send) => ownerRelay(Relay, pi, send) }
}
