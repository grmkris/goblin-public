import {
  AgentDoc,
  type AgentState,
  AssistantEntry,
  type ConversationId,
  type Extension,
  GenerationTask,
  type Harness,
  type PhaseHandler,
  type TaskId,
  type Tx,
  defineDoc,
  defineExtension,
  defineTask,
  hook,
} from '@earendil-works/pi-durable'
import {
  NOTHING,
  type PersonaAnswerData,
  type PersonaAvatar,
  type PersonaHold,
  type PersonaSetup,
} from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { heldCall } from '../attention.ts'
import { requireBudget } from '../budget.ts'
import { Conversations } from '../chats/service.ts'
import { requireResident } from '../mcp/service.ts'
import { FlowEvents } from '../observability/flows.ts'
import { Invocations } from '../personas/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { withContext } from './context-tail.ts'
import { authoredContent } from './content.ts'
import { BACKGROUND, entryId } from './context.ts'
import { MODEL_PROVIDER } from './model.ts'
import { ConversationMissing, answerText } from './subagent-relay.ts'
import { epochSeconds } from '../clock.ts'

/** The task kind of one Persona answering one owner message. */
export const PERSONA_TURN = 'goblin.persona-turn'

/**
 * What marks a conversation as a Persona's fork: the text of the revision it answers with, frozen when the owner sent
 * the message. A `beforeRequest` hook puts it in the context tail of this conversation only.
 */
const PersonaText = defineDoc<{ text: string }>({
  kind: 'app.persona-turn',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ text: '' }),
})

/** Guards an ask: the tasks made for one owner operation, so a replayed send makes none twice. */
const PersonaAsks = defineDoc<{ tasks: Record<string, TaskId<null>[]> }>({
  kind: 'app.persona-asks',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ tasks: {} }),
})

/** Remembered asks per conversation: older ones can no longer be replayed. */
const ASKS_KEPT = 100

/** Remembers the tasks made for `operationId`, so a replay makes none twice, and forgets all but the newest asks. */
function remember(asks: { tasks: Record<string, TaskId<null>[]> }, operationId: string, ids: TaskId<null>[]): void {
  asks.tasks[operationId] = ids
  const keys = Object.keys(asks.tasks)
  for (const key of keys.slice(0, Math.max(0, keys.length - ASKS_KEPT))) delete asks.tasks[key]
}

/** A Persona at the revision the owner's message froze. */
export type FrozenPersona = {
  readonly id: number
  readonly name: string
  readonly revision: number
  readonly avatar: PersonaAvatar
  readonly role: string
  readonly instructions: string
  readonly model?: string
  /** What it adds to its Topic's setup (ADR 0040); a turn started before setups has none and adds nothing. */
  readonly setup?: PersonaSetup
}

type Input = {
  readonly operationId: string
  /** The chat the owner asked in: the answer is written back there. */
  readonly chat: string
  readonly parent: ConversationId
  readonly order: number
  /** In a sequence, the task of the Persona asked before this one, which this one waits for. */
  readonly previous: TaskId<null> | null
  readonly previousPersona: number | null
  readonly persona: FrozenPersona
  /** How the owner asked: every Persona at once, or in sequence. Turns started before it was kept have none. */
  readonly mode?: 'parallel' | 'sequence'
  /**
   * The owner's reply to the Persona's hold (ADR 0041): the turn goes on in the Persona's fork from it, with no new
   * fork, and answers again.
   */
  readonly resume?: { readonly fork: ConversationId; readonly text: string }
}

type State =
  | { readonly phase: 'wait' }
  /** Until the owner's message (the ask) is in the chat: `at` is the entry the fork is cut at. */
  | { readonly phase: 'place'; readonly polls: number }
  | { readonly phase: 'fork'; readonly at: number }
  | { readonly phase: 'register'; readonly fork: ConversationId }
  | { readonly phase: 'ask'; readonly fork: ConversationId }
  /** The answer, and what it stopped on when the Persona needs the owner first (ADR 0041). */
  | { readonly phase: 'write'; readonly text: string; readonly hold?: PersonaHold }

/** The tools a Persona never has: it does not delegate, loop, organize or ask the owner anything. */
export const PERSONA_DENIED_TOOLS: readonly string[] = [
  'subagent_spawn',
  'subagent_send',
  'subagent_stop',
  'subagent_status',
  'subagent_config',
  'share_back',
  'ask_user',
  'topic_create',
  'topic_rename',
  'topic_archive',
  'topic_setup',
  'persona_create',
  'persona_update',
  'routine_propose',
  'routine_pause',
  'home_edit',
]

/** Extensions a Persona's fork leaves out: main's memory belongs to Goblin, not to a Persona. */
const PERSONA_LEFT_OUT = ['goblin.memory']
const PERSONA_EXTENSION = 'goblin.persona-turn'

/**
 * The fork's stored selection with the Persona's changes: extensions without main's memory and with the Persona turn
 * extension, tools without the ones a Persona never has. Names only, as Pi stores them; an exact list stays exact.
 */
export function personaSelection(
  state: Pick<AgentState, 'extensions' | 'tools'>,
  denied: readonly string[] = PERSONA_DENIED_TOOLS,
): Pick<AgentState, 'extensions' | 'tools'> {
  const extensions = state.extensions
  const leftOut = new Set(PERSONA_LEFT_OUT)
  const kept = (names: readonly string[] | undefined) => (names ?? []).filter((name) => !leftOut.has(name))
  const withTurn = (names: readonly string[]) =>
    names.includes(PERSONA_EXTENSION) ? [...names] : [...names, PERSONA_EXTENSION]
  const nextExtensions = Array.isArray(extensions)
    ? withTurn(kept(extensions))
    : {
        add: withTurn(kept(extensions?.add)),
        remove: [...new Set([...(extensions?.remove ?? []), ...PERSONA_LEFT_OUT])].filter(
          (name) => name !== PERSONA_EXTENSION,
        ),
      }
  const tools = state.tools
  const nextTools = Array.isArray(tools)
    ? tools.filter((name) => !denied.includes(name))
    : { remove: [...new Set([...(tools?.remove ?? []), ...denied])] }
  return { extensions: nextExtensions, tools: nextTools }
}

/** What a Persona answers: the owner's message it was tagged in, or the work a routine hands it (ADR 0041). */
const ASKED = {
  tagged: (name: string) =>
    `The owner tagged @${name} in the conversation above: answer their message once, as ${name}, in your own voice.`,
  routine: (name: string) =>
    `A routine the owner confirmed hands you its work: do it once, as ${name}, in your own voice.`,
} as const

/** The text of a Persona's revision as its model reads it, in the context tail of its fork or its routine's run. */
export function personaText(
  persona: Pick<FrozenPersona, 'name' | 'role' | 'instructions'>,
  asked: keyof typeof ASKED = 'tagged',
): string {
  const { name, role, instructions } = persona
  const text = [
    `You are ${name}${role === '' ? '' : `, ${role}`}. ${ASKED[asked](name)} For this answer you are not goblin.`,
    'You cannot start subagents, organize topics or personas, or ask the owner anything; if you need more from them, say so in your answer.',
    instructions === '' ? '' : `The owner's instructions for ${name}:\n${instructions}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
  // The text sits inside the context block: nothing in it may close a tag.
  return text.replaceAll('</', '<\u200B/')
}

/** Marks `conversation` a Persona's, in the commit that makes it: its context tail carries `text` (`personaText`). */
export async function markPersona(tx: Tx, conversation: ConversationId, text: string): Promise<void> {
  const marker = await tx.doc(PersonaText, conversation)
  marker.text = text
}

const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
const failed = (message: string) => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }) as const

/** The instance clock in epoch seconds, as the invocation rows and the budget keep time. */

/** How a Persona's answer flow ended: answered, failed, or stopped by the owner (a refusal of the work). */
const ANSWER_STATUS = {
  answered: { status: 'ok' },
  failed: { status: 'error', errorType: 'failed' },
  stopped: { status: 'refused', errorType: 'stopped' },
} as const

/**
 * Settles an invocation row: answered (with its entry), failed or stopped. The call that settles it records the
 * Persona's `persona_answer` flow, once; a settled row stays as it is and records nothing.
 */
const settle = (input: Input, state: 'answered' | 'failed' | 'stopped', entry?: number) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    const settled = yield* (yield* Invocations).settle(input.operationId, input.persona.id, state, now, entry)
    if (!settled) return
    yield* FlowEvents.record({
      flow: 'persona_answer',
      via: 'system',
      actor: 'persona',
      chat: input.chat,
      operationId: input.operationId,
      ...(input.mode === undefined ? {} : { personaOrder: input.mode }),
      ...ANSWER_STATUS[state],
    })
  })

/**
 * What a Persona's fork works with: its Topic's setup joined with the setup the ask froze (ADR 0040), never subagents.
 * A turn started before setups has none and adds nothing.
 */
const registerFork = (input: Input, fork: ConversationId) =>
  Effect.gen(function* () {
    const { id, revision, name, setup } = input.persona
    yield* (yield* Conversations).registerPersona(String(fork), input.chat, {
      id,
      revision,
      name,
      setup: setup ?? NOTHING,
    })
    yield* (yield* Invocations).running(input.operationId, input.persona.id)
  })

/** What the fork may do before the model is asked: the owner's authority is current and the day's budget is not spent. */
const mayAnswer = Effect.gen(function* () {
  yield* requireResident
  yield* requireBudget
})

type Phase<P extends State['phase']> = PhaseHandler<Input, Extract<State, { phase: P }>, State, null, object>

/** In a sequence the turn waits for the one before it; then it looks for the owner's message in the chat. */
const waitPhase: Phase<'wait'> = async (task, runtime, context) => {
  const { previous } = task.input
  await runtime.commit(
    () =>
      previous === null
        ? { status: 'running', checkpoint: { phase: 'place', polls: 0 } }
        : { status: 'waiting', checkpoint: { phase: 'place', polls: 0 }, on: [previous], policy: 'allSettled' },
    context,
  )
}

/**
 * Until the owner's message (the ask) is in the chat: a queued write lands at the chat's next boundary, so this polls in
 * short sleeps and never holds anything. In a sequence the fork is cut at the answer before it, otherwise at the ask.
 */
const placePhase =
  (run: RunProgram): Phase<'place'> =>
  async (task, runtime, context) => {
    const { operationId, parent, previousPersona } = task.input
    const { polls } = task.state.checkpoint
    const before =
      previousPersona === null
        ? undefined
        : Option.getOrUndefined(
            await run(Invocations.use((invocations) => invocations.get(operationId, previousPersona))),
          )
    const seen: { outcome: 'placed' | 'waiting' | 'missing' } = { outcome: 'waiting' }
    await runtime.commit(async (tx) => {
      const ask = await tx.submissionByRequest(parent, operationId)
      if (ask === undefined || ask.status === 'unanswered') {
        seen.outcome = 'missing'
        return failed('The owner message is not in the chat.')
      }
      if (ask.status !== 'done') return { status: 'running', checkpoint: { phase: 'place', polls: polls + 1 } }
      seen.outcome = 'placed'
      const at = before?.state === 'answered' && before.answerEntry !== undefined ? before.answerEntry : ask.entry
      return { status: 'running', checkpoint: { phase: 'fork', at } }
    }, context)
    if (seen.outcome === 'missing') await run(settle(task.input, 'failed'))
    if (seen.outcome === 'waiting') await runtime.sleep(runtime.now() + Math.min(2000, 250 * (polls + 1)), context)
  }

/** Forks the chat, owned by this task, as the Persona: its selection, model and frozen text, in one commit. */
const forkPhase: Phase<'fork'> = async (task, runtime, context) => {
  const { parent, persona } = task.input
  const at = entryId(task.state.checkpoint.at)
  await runtime.commit(async (tx, current) => {
    const forked = await tx.forkConversation(parent, at, { ownership: { kind: 'task', taskId: current.id } })
    const agent = await tx.doc(AgentDoc, forked.id)
    const selection = personaSelection(agent)
    if (selection.extensions !== undefined) agent.extensions = selection.extensions
    if (selection.tools !== undefined) agent.tools = selection.tools
    if (persona.model !== undefined) agent.model = { provider: MODEL_PROVIDER, modelId: persona.model }
    await markPersona(tx, forked.id, personaText(persona))
    return { status: 'running', checkpoint: { phase: 'register', fork: forked.id } }
  }, context)
}

const registerPhase =
  (run: RunProgram): Phase<'register'> =>
  async (task, runtime, context) => {
    const { fork } = task.state.checkpoint
    await run(registerFork(task.input, fork))
    await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'ask', fork } }), context)
  }

/** What the fork is asked: to answer the owner's message, or to go on from the owner's reply to its hold. */
const promptOf = ({ operationId, persona, resume }: Input) =>
  resume === undefined
    ? {
        content: `Answer the owner's message above as @${persona.name}.`,
        requestId: `persona:${operationId}:${String(persona.id)}`,
      }
    : { content: resume.text, requestId: `persona-resume:${operationId}:${String(persona.id)}` }

/** The call the fork's turn held for the owner since it was asked, from goblin's own markers; none when it held none. */
async function heldIn(tx: Tx, fork: ConversationId, requestId: string): Promise<PersonaHold | undefined> {
  const asked = await tx.submissionByRequest(fork, requestId)
  if (asked?.entry === undefined) return undefined
  const after = await tx.scanEntries({ conversationId: fork, minEntryId: entryId(Number(asked.entry) + 1) }, 50)
  for (const entry of after.items) {
    const held = heldCall(entry)
    if (held !== undefined) return holdJson({ ...held, fork: String(fork) })
  }
  return undefined
}

/** A hold as an entry keeps it: JSON with no key left undefined. */
const holdJson = ({ kind, approvalId, requestId, scope, connectionId, name, fork }: PersonaHold) => ({
  kind,
  connectionId,
  name,
  fork,
  ...(approvalId === undefined ? {} : { approvalId }),
  ...(requestId === undefined ? {} : { requestId }),
  ...(scope === undefined ? {} : { scope }),
})

/** What a Persona's answer says when it stopped on a hold without words of its own. */
const HOLD_TEXT: Readonly<Record<PersonaHold['kind'], string>> = {
  approval: 'I need your approval for this call before I can go on.',
  grant: 'I need you to allow this tool before I can go on.',
  url: 'I need you to finish a step on the server’s site before I can go on.',
  access: 'I need you to sign in to this connection again with more access before I can go on.',
  connect: 'I need you to connect this before I can go on.',
}
const holdText = (hold: PersonaHold): string => HOLD_TEXT[hold.kind]

/**
 * Prompts the fork and takes its answer, and what it stopped on when it needs the owner first (ADR 0041); a stopped,
 * empty or refused answer settles the invocation instead.
 */
const askPhase =
  (run: RunProgram): Phase<'ask'> =>
  async (task, runtime, context) => {
    const { fork } = task.state.checkpoint
    const conversation = await runtime.conversation(fork, context)
    const unavailable = await run(mayAnswer).then(
      () => false,
      () => true,
    )
    if (conversation === undefined || unavailable) {
      await run(settle(task.input, 'failed'))
      await runtime.commit(() => failed('The Persona could not answer.'), context)
      return
    }
    const { content, requestId } = promptOf(task.input)
    const submitted = await conversation.submit({ type: 'input', content, whenBusy: 'followUp', requestId }, context)
    const settled = await submitted.wait(context)
    // The answer is an entry of the fork, which the turn's own conversation cannot see: read it in a commit.
    const read = { answered: false }
    await runtime.commit(async (tx) => {
      const entry =
        settled.status === 'done' && settled.type === 'input'
          ? await tx.entry(AssistantEntry, settled.answer)
          : undefined
      const hold = await heldIn(tx, fork, requestId)
      const text = answerText(entry).trim() || (hold === undefined ? '' : holdText(hold))
      read.answered = text !== ''
      if (!read.answered) return failed('The Persona gave no answer.')
      return { status: 'running', checkpoint: { phase: 'write', text, ...(hold === undefined ? {} : { hold }) } }
    }, context)
    if (!read.answered) {
      const aborted = settled.status === 'unanswered' && settled.reason === 'aborted'
      await run(settle(task.input, aborted ? 'stopped' : 'failed'))
    }
  }

/**
 * Writes the answer into the chat, attributed and holding the revision it was given at, and what it stopped on, then
 * settles: an answer that waits on the owner is still an answer, and their reply asks the Persona again.
 */
const writePhase =
  (run: RunProgram): Phase<'write'> =>
  async (task, runtime, context) => {
    const { text, hold } = task.state.checkpoint
    const { operationId, chat, persona } = task.input
    const data = {
      persona: persona.id,
      name: persona.name,
      revision: persona.revision,
      avatar: persona.avatar,
      operationId,
      text,
      ...(hold === undefined ? {} : { hold: holdJson(hold) }),
    } satisfies PersonaAnswerData
    const entry = await run(
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis
        const written = yield* (yield* Conversations).writeEntry(chat, `persona:${operationId}:${String(persona.id)}`, {
          kind: 'app.persona',
          data,
          model: [{ role: 'user', content: authoredContent(`persona ${persona.name}`, text), timestamp }],
        })
        return Option.getOrUndefined(yield* written.placed)
      }),
    )
    await run(settle(task.input, entry === undefined ? 'failed' : 'answered', entry))
    await runtime.commit(() => terminal, context)
  }

/**
 * The Persona turn: wait for the one before it, fork the chat, ask the fork, write the answer back attributed. A turn
 * that resumes a hold (ADR 0041) asks the Persona's fork again with the owner's reply and writes its next answer.
 */
function turnTask(run: RunProgram) {
  return defineTask<Input, State, null>({
    name: PERSONA_TURN,
    version: 1,
    initial: (input) => (input.resume === undefined ? { phase: 'wait' } : { phase: 'ask', fork: input.resume.fork }),
    phases: {
      wait: waitPhase,
      place: placePhase(run),
      fork: forkPhase,
      register: registerPhase(run),
      ask: askPhase(run),
      write: writePhase(run),
    },
    abort: async (task, runtime, context) => {
      await run(settle(task.input, 'stopped'))
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
    },
  })
}

/** What one ask needs: the owner's operation, where it was asked, and the Personas in the order they answer. */
export type PersonaAsk = {
  readonly operationId: string
  readonly chat: string
  readonly parent: ConversationId
  readonly personas: readonly FrozenPersona[]
  readonly order: 'parallel' | 'sequence'
}

/** What going on after a hold needs (ADR 0041): the owner's reply, where it goes, and the Persona it resumes. */
export type PersonaResume = {
  readonly operationId: string
  readonly chat: string
  readonly parent: ConversationId
  readonly fork: ConversationId
  readonly persona: FrozenPersona
  readonly text: string
}

export type PersonaTurnKit = {
  /** Selected by the fork only: marks it a Persona's and adds the Persona to its context tail. */
  readonly extension: Extension
  /** Creates the Persona turns of an ask, once per operation. */
  readonly start: (pi: Harness, ask: PersonaAsk) => Promise<void>
  /** Creates the turn that goes on in a Persona's fork from the owner's reply to its hold, once per operation. */
  readonly resume: (pi: Harness, resume: PersonaResume) => Promise<void>
  /** Aborts the unsettled turns asked in `parent`, so a Stop drops them. */
  readonly drop: (pi: Harness, parent: ConversationId) => Promise<number>
}

/**
 * Personas answer in the chat they were tagged in (ADR 0033), without Goblin: each turn forks the chat at the owner's
 * message, prompts the fork as that Persona, and writes the answer back as an attributed `app.persona` entry. Turns are
 * background tasks of the chat, so the chat's own run is neither held nor queued behind them.
 */
export function personaTurnExtension(run: RunProgram): PersonaTurnKit {
  const Turn = turnTask(run)
  const extension = defineExtension({
    name: PERSONA_EXTENSION,
    tasks: [Turn],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const marker = await api.snapshot(PersonaText, api.conversationId, context)
          return marker === undefined || marker.text === ''
            ? undefined
            : { messages: withContext(messages, 'persona', marker.text) }
        },
      }),
    ],
  })
  return {
    extension,
    start: async (pi, ask) => {
      const parent = await pi.conversation(ask.parent, BACKGROUND)
      if (parent === undefined) throw new ConversationMissing({ missing: 'persona_ask' })
      await parent.commit(async (tx) => {
        const asks = await tx.doc(PersonaAsks, ask.parent)
        if (asks.tasks[ask.operationId] !== undefined) return
        const ids: TaskId<null>[] = []
        for (const [order, persona] of ask.personas.entries()) {
          const previous = ask.order === 'sequence' ? (ids[order - 1] ?? null) : null
          const before = ask.order === 'sequence' ? (ask.personas[order - 1]?.id ?? null) : null
          ids.push(
            await tx.createTask(
              Turn,
              {
                operationId: ask.operationId,
                chat: ask.chat,
                parent: ask.parent,
                order,
                previous,
                previousPersona: before,
                persona,
                mode: ask.order,
              },
              { ownership: { kind: 'conversation' }, background: true },
            ),
          )
        }
        remember(asks, ask.operationId, ids)
      }, BACKGROUND)
      pi.resume()
    },
    resume: async (pi, { operationId, chat, parent, fork, persona, text }) => {
      const conversation = await pi.conversation(parent, BACKGROUND)
      if (conversation === undefined) throw new ConversationMissing({ missing: 'persona_resume' })
      await conversation.commit(async (tx) => {
        const asks = await tx.doc(PersonaAsks, parent)
        if (asks.tasks[operationId] !== undefined) return
        const input = { operationId, chat, parent, order: 0, previous: null, previousPersona: null, persona }
        const task = await tx.createTask(
          Turn,
          { ...input, resume: { fork, text } },
          { ownership: { kind: 'conversation' }, background: true },
        )
        remember(asks, operationId, [task])
      }, BACKGROUND)
      pi.resume()
    },
    drop: async (pi, parent) => {
      const { tasks } = await pi.inspect(BACKGROUND)
      let dropped = 0
      for (const { record } of tasks)
        if (record.kind === PERSONA_TURN && record.conversationId === parent) {
          await pi.abortTask(record.id, BACKGROUND)
          dropped += 1
        }
      return dropped
    },
  }
}
