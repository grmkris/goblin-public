import {
  AssistantEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type SettledSubmissionRecord,
  type Task,
  type ToolExecutionApi,
  type Tx,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
} from '@earendil-works/pi-durable'
import { type Static, Type } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import { MAIN_THREAD } from '@purrable/contracts'
import { Channel, Conversations, attempt, attemptSync, nowSecondsEffect } from '../services.ts'
import { authoredContent } from './content.ts'
import type { RunProgram } from './resident-mcp.ts'

/** The tool that starts subagents: what a conversation with subagents switched off has filtered out (ADR 0010). */
export const SUBAGENT_TOOL = 'subagent'

/** Subagents working at once, across the agent: each one spends the owner's budget on its own. */
const MAX_RUNNING = 3

const GUIDE = [
  'The `subagent` tool starts subagents: helpers that work in the background, each in a conversation of its own, with',
  "the owner's tools and grants. Use one for a job that takes a while or can be done apart from the conversation. A",
  "subagent's answer comes back to you as a message starting `[from subagent <name>]`: tell the owner what matters in",
  `it. At most ${MAX_RUNNING} subagents work at once.`,
].join(' ')

const instructions = (name: string) =>
  [
    `You are the subagent "${name}", started by the owner's agent to do one job. Do it and answer with the result:`,
    'your answer is reported to the agent that started you. You cannot ask the owner anything; if you need something',
    'from them, say so in your answer.',
  ].join(' ')

type Subagent = {
  readonly conversationId: ConversationId
  /** Answers already reported: several messages can end in one answer, reported once. */
  readonly reported: EntryId[]
}

/** The subagents a conversation started, by name. A thread branched from main starts without main's. */
const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
  kind: 'app.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {} }),
})

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

/** The text of an answer entry; empty when it has none (a run that a tool ended). */
function answerText(entry: Pick<EntryRecord, 'model'> | undefined): string {
  const message = entry?.model?.[0]
  if (message?.role !== 'assistant') return ''
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

type ReporterInput = { readonly name: string; readonly conversationId: ConversationId; readonly message: string }
type ReporterState = { readonly phase: 'deliver' } | { readonly phase: 'report'; readonly report?: string }
type Reporter = Task<ReporterInput, ReporterState, null, object>

const background = { ownership: { kind: 'conversation' }, background: true } as const
const toReport = (report?: string) =>
  ({ status: 'running', checkpoint: { phase: 'report', ...(report === undefined ? {} : { report }) } }) as const

/**
 * What a settled message to a subagent reports, decided in the reporter's commit so a restart does not decide again:
 * nothing when it was stopped or its answer was already reported, else the answer or the failure.
 */
async function decideReport(tx: Tx, spawner: ConversationId, name: string, settled: SettledSubmissionRecord) {
  if (settled.status === 'unanswered')
    return toReport(settled.reason === 'aborted' ? undefined : `It failed: ${settled.reason}.`)
  if (settled.type !== 'input') return toReport()
  const agent = (await tx.doc(Subagents, spawner)).agents[name]
  if (agent === undefined || agent.reported.includes(settled.answer)) return toReport()
  agent.reported.push(settled.answer)
  const answer = answerText(await tx.entry(AssistantEntry, settled.answer))
  return toReport(answer === '' ? 'It ended without an answer; its conversation shows why.' : answer)
}

/**
 * Delivers one message to a subagent, waits for its answer and posts it into the spawner as an input it answers.
 * Request ids keep a restart from delivering or reporting twice.
 */
function reporterTask(run: RunProgram): Reporter {
  return defineTask<ReporterInput, ReporterState, null>({
    name: 'purrable.subagent-reporter',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, message } = reporter.input
        const parent = String(runtime.conversationId)
        await run(
          Effect.gen(function* () {
            const conversations = yield* Conversations
            const now = yield* nowSecondsEffect
            yield* attemptSync(() => conversations.registerSubagent(String(conversationId), parent, name, now))
          }),
        )
        const subagent = await runtime.conversation(conversationId, context)
        if (subagent === undefined) throw new Error(`Subagent ${name} has no conversation`)
        const submission = await subagent.submit(
          { type: 'input', content: message, whenBusy: 'followUp', requestId: `subagent:${reporter.id}` },
          context,
        )
        const settled = await submission.wait(context)
        await runtime.commit(async (tx) => decideReport(tx, runtime.conversationId, name, settled), context)
      },
      // A follow-up input: it starts a turn when the spawner is idle, or waits for its current answer.
      report: async (reporter, runtime, context) => {
        const { report } = reporter.state.checkpoint
        if (report !== undefined) {
          const spawner = await runtime.conversation(runtime.conversationId, context)
          await spawner?.submit(
            {
              type: 'input',
              content: authoredContent(`subagent ${reporter.input.name}`, report),
              whenBusy: 'followUp',
              requestId: `subagent-report:${reporter.id}`,
            },
            context,
          )
          // Main's answer to a report goes to Telegram too when the channel is on (channel/channel.ts).
          if (String(runtime.conversationId) === MAIN_THREAD)
            await run(
              Effect.gen(function* () {
                const channel = yield* Channel
                channel.track(`subagent-report:${reporter.id}`, yield* nowSecondsEffect)
              }),
            )
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
      },
    },
    abort: (_reporter, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

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
const reply = (text: string, name?: string, conversationId?: ConversationId) => ({
  content: [{ type: 'text' as const, text }],
  ...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
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
 * Background subagents behind one `subagent` tool, after Pi Durable's example 23. A subagent is a conversation owned by
 * an anchor task of its spawner, given exactly `members` (no subagents of its own, no `ask_user`). Each message goes
 * through a reporter task, and the answer comes back to the spawner as an input. The app registry lists each subagent
 * under its spawner, so the owner can open it.
 */
export function subagentsExtension(run: RunProgram, members: readonly Extension[]) {
  const Reporter = reporterTask(run)

  /** A conversation for a new subagent, owned by an anchor of the spawner and given exactly `members`. */
  async function spawn(tx: Tx, name: string): Promise<ConversationId> {
    const anchor = await tx.createTask(Anchor, null, background)
    // A task-owned conversation starts as a copy of the spawner's agent: its model and settings.
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })
    await configure(tx, child.id, { extensions: members, instructions: instructions(name) })
    return child.id
  }

  /** spawn and send: one commit starts the subagent if new, and a reporter for the message. */
  async function deliver(api: Api, action: 'spawn' | 'send', name: string, message: string, context: CallContext) {
    const working = await run(Conversations.use((conversations) => attempt(() => conversations.runningSubagents())))
    if (working >= MAX_RUNNING) return reply(`${MAX_RUNNING} subagents are already working; wait for one to report.`)
    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId)
      const existing = known(state.agents, name)
      if (action === 'spawn' && existing !== undefined) return `${name} already exists; use send.`
      const conversationId = existing?.conversationId ?? (await spawn(tx, name))
      state.agents[name] ??= { conversationId, reported: [] }
      await tx.createTask(Reporter, { name, conversationId, message }, background)
      return action === 'spawn' ? `Started ${name}.` : `Sent to ${name}.`
    }, context)
    const current = (await api.snapshot(Subagents, api.conversationId, context))?.agents[name]
    return reply(result, name, current?.conversationId)
  }

  const tool = defineTool({
    name: SUBAGENT_TOOL,
    description: [
      'Manage background subagents. spawn (name, message) starts one on a job; send (name, message) gives it another',
      'after its current answer; stop (name) aborts its current work; status (name, or none for all) says who is',
      'working. Answers are reported back to you when they arrive.',
    ].join(' '),
    parameters: Args,
    // An interrupted call is not rerun: repeating a spawn or a stop could start or stop newer work. The model sees
    // the call was interrupted and can check with status.
    replay: 'unsafe',
    execute: async ({ action, name, message }: Args, api, context) => {
      const { agents } = (await api.snapshot(Subagents, api.conversationId, context)) ?? { agents: {} }
      if (action === 'status') return status(api, agents, name, context)
      if (name === undefined) return reply(`${action} needs a name.`)
      const agent = known(agents, name)
      if (action !== 'spawn' && agent === undefined) return reply(`No subagent named ${name}.`)
      if (action === 'stop') {
        if (agent !== undefined) await (await api.conversation(agent.conversationId, context))?.abort(context)
        return reply(`Stopped ${name}.`, name, agent?.conversationId)
      }
      if (message === undefined) return reply(`${action} needs a message.`)
      return deliver(api, action, name, message, context)
    },
  })

  return defineExtension({
    name: 'purrable.subagents',
    sections: [section('subagents', () => GUIDE)],
    tasks: [Anchor, Reporter],
    tools: [tool],
  })
}
