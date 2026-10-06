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
  section,
} from '@earendil-works/pi-durable'
import type { UserMessage } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Capabilities, Conversations, attempt, nowSecondsEffect, requireResident } from '../services.ts'
import { capabilityOffResult } from './capabilities.ts'
import { BACKGROUND, conversationId } from './context.ts'
import type { RunProgram } from './resident-mcp.ts'
import {
  type Relay,
  type Subagent,
  Subagents,
  background,
  carriesRequest,
  liveRelays,
  quoted,
  relayTask,
} from './subagent-relay.ts'
import { ReadyResult, typedTool } from './typed-tool.ts'

/** The subagent tools: what a conversation with subagents switched off has filtered out (ADR 0010, ADR 0027). */
const SUBAGENT_TOOLS: readonly string[] = ['subagent_spawn', 'subagent_send', 'subagent_stop', 'subagent_status']

const GUIDE = [
  '`subagent_spawn` starts a subagent: a helper that works in the background, in a conversation of its own, with the',
  "owner's tools and grants, and subagents of its own when a job splits. Use one for a job that takes a while or can",
  "be done apart from the conversation. A subagent's final answer comes back to you as a message starting",
  '`[from subagent <name>]`, once it and its own helpers are done: tell whoever you answer what matters in it. A',
  'subagent closes when its job is done; `subagent_send` gives it another job and it picks up where it left off.',
  '`subagent_stop` stops one and its own subagents; `subagent_status` says who is working.',
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
  name: 'goblin.subagent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
})

type Api = ToolExecutionApi
type CallContext = Parameters<Api['commit']>[1]
type Agents = Readonly<Record<string, Subagent>>

const known = (agents: Agents, name: string) => (Object.hasOwn(agents, name) ? agents[name] : undefined)

const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,40}$/u))
const Message = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000))

/**
 * What a call did to a subagent, and its conversation once it has one: the web shows that conversation in place of
 * the call.
 */
const Done = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(['started', 'exists', 'sent', 'reopened', 'closed-by-owner', 'stopped', 'unknown']),
  conversationId: Schema.optionalKey(Schema.Number),
})
type Done = typeof Done.Type

const said = ({ name, outcome }: Done): string => {
  switch (outcome) {
    case 'started':
      return `Started ${name}.`
    case 'exists':
      return `${name} already exists; use subagent_send.`
    case 'sent':
      return `Sent to ${name}.`
    case 'reopened':
      return `Sent to ${name}; it had closed when its job was done and is open again.`
    case 'closed-by-owner':
      return `The owner closed ${name}; it takes no messages until they reopen it.`
    case 'stopped':
      return `Stopped ${name}.`
    case 'unknown':
      return `No subagent named ${name}.`
  }
}

/** The details that link the call to the subagent's conversation in the web. */
const linked = ({ name, conversationId: thread }: Done) =>
  thread === undefined ? {} : { name, conversationId: thread }

const done = (name: string, outcome: Done['outcome'], agent: Subagent | undefined): Done => ({
  name,
  outcome,
  ...(agent === undefined ? {} : { conversationId: agent.conversationId }),
})

const Working = Schema.Struct({
  subagents: Schema.Array(Schema.Struct({ name: Schema.String, working: Schema.Boolean })),
})

/** Who is working: one subagent, or every subagent this conversation started. */
async function status(api: Api, agents: Agents, name: string | undefined, context: CallContext) {
  const subagents: { name: string; working: boolean }[] = []
  for (const each of name === undefined ? Object.keys(agents) : [name]) {
    const agent = known(agents, each)
    if (agent === undefined) continue
    subagents.push({
      name: each,
      working: (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined,
    })
  }
  return { subagents }
}

/**
 * Whether the spawner may send to a subagent: not one the owner closed, until they reopen it; one closed because its
 * job was done opens again for the next one.
 */
async function admit(run: RunProgram, agent: Subagent | undefined): Promise<'open' | 'reopened' | 'closed-by-owner'> {
  if (agent === undefined) return 'open'
  const session = String(agent.conversationId)
  const view = await run(Conversations.use((conversations) => attempt(() => conversations.view(session))))
  if (view?.closedBy === 'owner') return 'closed-by-owner'
  if (view?.closedBy !== 'done') return 'open'
  await run(
    Effect.gen(function* () {
      const conversations = yield* Conversations
      const now = yield* nowSecondsEffect
      yield* attempt(() => conversations.update(session, { closed: false }, now))
    }),
  )
  return 'reopened'
}

/**
 * Stop: its current work and everything its own subagents are doing, through every level. What was on its way to it
 * stops first, so nothing reports the job cut short.
 */
async function stop(run: RunProgram, api: Api, agent: Subagent, context: CallContext) {
  const session = String(agent.conversationId)
  const child = await api.conversation(agent.conversationId, context)
  await run(Conversations.use((conversations) => attempt(() => conversations.stopSubagents(session))))
  await child?.abort(context, { background: true })
}

type Deliver = (
  api: Api,
  action: 'spawn' | 'send',
  name: string,
  message: string,
  context: CallContext,
) => Promise<Done>

/**
 * The subagent tools, one per action, behind the conversation's subagents switch: spawn and send start work, so an
 * interrupted call is not rerun (repeating one could start newer work twice; the model sees the interruption and can
 * check with subagent_status), and neither is a stop.
 */
function subagentTools(run: RunProgram, deliver: Deliver): readonly ToolRegistration[] {
  const roster = async (api: Api, context: CallContext): Promise<Agents> => {
    await run(requireResident)
    return (await api.snapshot(Subagents, api.conversationId, context))?.agents ?? {}
  }
  /** Pi's tool filter hides these tools where subagents are switched off; a call that still arrives starts nothing. */
  const off = async (api: Api) => {
    const scope = await run(Capabilities.useSync((capabilities) => capabilities.scope(String(api.conversationId))))
    return scope.subagents() ? undefined : new ReadyResult(capabilityOffResult({ kind: 'subagents' }, scope))
  }
  const common = { output: Done, text: said, details: linked } as const
  return [
    typedTool({
      name: 'subagent_spawn',
      description: 'Start a subagent named `name` on a job (`message`). Its final answer is reported back to you.',
      input: Schema.Struct({ name: Name, message: Message }),
      ...common,
      replay: 'unsafe',
      execute: async ({ name, message }, api, context) => {
        await roster(api, context)
        return (await off(api)) ?? deliver(api, 'spawn', name, message, context)
      },
    }),
    typedTool({
      name: 'subagent_send',
      description: 'Give a subagent another job (`message`), after its current answer.',
      input: Schema.Struct({ name: Name, message: Message }),
      ...common,
      replay: 'unsafe',
      execute: async ({ name, message }, api, context) => {
        if (known(await roster(api, context), name) === undefined) return done(name, 'unknown', undefined)
        return (await off(api)) ?? deliver(api, 'send', name, message, context)
      },
    }),
    typedTool({
      name: 'subagent_stop',
      description: "Stop a subagent's current work and everything its own subagents are doing.",
      input: Schema.Struct({ name: Name }),
      ...common,
      replay: 'unsafe',
      execute: async ({ name }, api, context) => {
        const agent = known(await roster(api, context), name)
        if (agent === undefined) return done(name, 'unknown', undefined)
        await stop(run, api, agent, context)
        return done(name, 'stopped', agent)
      },
    }),
    typedTool({
      name: 'subagent_status',
      description: 'Say which subagents are working: one by `name`, or every one you started.',
      input: Schema.Struct({ name: Schema.optionalKey(Name) }),
      output: Working,
      replay: 'safe',
      execute: async ({ name }, api, context) => status(api, await roster(api, context), name, context),
      text: ({ subagents }) =>
        subagents.length === 0
          ? 'No subagents.'
          : subagents.map(({ name, working }) => `${name}: ${working ? 'working' : 'idle'}`).join('\n'),
    }),
  ]
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
  /** The subagent tools, which a conversation with subagents switched off has filtered out. */
  readonly tools: readonly ToolRegistration[]
  /**
   * The owner's message to a subagent, carried like the spawner's by a relay in the spawner, so the answer reports up.
   * False when that operation is already on its way or delivered.
   */
  readonly ownerSend: (pi: Harness, send: OwnerSend) => Promise<boolean>
}

/**
 * Background subagents behind the `subagent_*` tools, after Pi Durable's example 23. A subagent is a conversation owned by
 * an anchor task of its spawner, given exactly `members(extension)`: the owner's tools and this extension again, so it
 * can start subagents of its own, at any depth (no `ask_user`). Each message goes through a relay task (`relayTask`),
 * and only the final answer comes back to the spawner. The registry lists each subagent under its spawner, so the
 * owner can open it.
 */
export function subagentsExtension(run: RunProgram, members: (self: Extension) => readonly Extension[]): SubagentKit {
  const Relay = relayTask(run)

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
    const roster = await api.snapshot(Subagents, api.conversationId, context)
    const before = roster === undefined ? undefined : known(roster.agents, name)
    const admitted = await admit(run, before)
    if (admitted === 'closed-by-owner') return done(name, admitted, before)
    const outcome = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId)
      const existing = known(state.agents, name)
      if (action === 'spawn' && existing !== undefined) return 'exists' as const
      const child = existing?.conversationId ?? (await spawn(tx, name))
      state.agents[name] ??= { conversationId: child, reported: [] }
      const input = { name, conversationId: child, content: message, origin: 'spawner', whenBusy: 'followUp' } as const
      await tx.createTask(Relay, input, background)
      if (action === 'spawn') return 'started' as const
      return admitted === 'reopened' ? ('reopened' as const) : ('sent' as const)
    }, context)
    return done(name, outcome, (await api.snapshot(Subagents, api.conversationId, context))?.agents[name])
  }

  const tools = subagentTools(run, deliver)
  const extension: Extension = defineExtension({
    name: 'goblin.subagents',
    // Only where the tool is offered: a conversation with subagents switched off has it filtered out.
    sections: [
      section('subagents', (input) =>
        input.agent.tools.some((offered) => SUBAGENT_TOOLS.includes(offered.name)) ? GUIDE : undefined,
      ),
    ],
    tasks: [Anchor, Relay],
    tools,
  })
  return { extension, tools, ownerSend: (pi, send) => ownerRelay(Relay, pi, send) }
}
