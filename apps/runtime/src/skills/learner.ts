// The skill learner: after a final answer that followed a correction or a request to remember how something was done,
// a cheap model decides whether the exchange teaches a reusable procedure, and if so the agent proposes a draft to the
// owner's skills library through its `skill_draft` tool. The owner reviews every draft there; nothing here publishes
// a skill. Facts about the owner stay in memory and are not skills. Drafts are capped per day, never repeated, and a
// rejected one is not proposed again.
import type { ConversationId } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { McpConnections, McpGrants } from '../mcp/service.ts'
import type { CheapModel } from '../memory/model.ts'
import { writeLine } from '../observability/logger.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { PiSessions } from '../pi/sessions.ts'
import { type TranscriptMessage, recentMessages } from '../pi/transcript.ts'
import { Learner, type Skills } from './service.ts'
import type { DraftLog, SkillState } from './store.ts'
import { digestOf } from './verify.ts'

/** The library tools a skills server offers for drafts (MySkills). */
export const DRAFT_TOOL = 'skill_draft'
export const DRAFT_STATUS_TOOL = 'skill_draft_status'

const DRAFTS_PER_DAY = 5
const DAY_MS = 86_400_000
const MAX_TRANSCRIPT = 12_000
const MAX_BODY = 20_000

/** A correction, a standing instruction, or a request to keep how something was done. */
const SIGNAL =
  /\b(no[,.!]|wrong|instead|actually|not what|should(?:n't| not)? have|next time|from now on|always|never|don't|do not|remember|you missed|you forgot|forgot to)\b|\b(save|turn|make|keep|update)\b.{0,40}\b(skill|procedure|playbook|how we did)\b/iu

const SYSTEM = [
  'You maintain reusable skills for a personal AI agent. A skill is a procedure: how to do a kind of task, as steps,',
  'checks and pitfalls. Given the latest exchange and the skills the agent used, decide whether it teaches a reusable',
  'procedure. Facts about the owner (preferences, people, dates, accounts) are not skills: answer none for those. Most',
  'exchanges teach nothing: then answer none. When the owner corrected how a used skill works, answer improve with the',
  'whole new body. Write procedures generally: never include names of people, email addresses, account ids, secrets,',
  'or quotes of private content.',
  'Answer with exactly one JSON object and nothing else:',
  '{"action":"none"}',
  '{"action":"new","name":"kebab-case-name","description":"one sentence: when to use it","body":"markdown steps","evidence":"one sentence on what taught this, with no private details"}',
  '{"action":"improve","skill":"<handle of the used skill>","description":"…","body":"…","evidence":"…"}',
].join('\n')

const Decision = Schema.Union([
  Schema.Struct({ action: Schema.Literal('none') }),
  Schema.Struct({
    action: Schema.Literal('new'),
    name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), Schema.isMaxLength(64)),
    description: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(300)),
    body: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(MAX_BODY)),
    evidence: Schema.String.check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    action: Schema.Literal('improve'),
    skill: Schema.String,
    description: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(300)),
    body: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(MAX_BODY)),
    evidence: Schema.String.check(Schema.isMaxLength(500)),
  }),
])
type Decision = typeof Decision.Type
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(Decision))

const DraftAnswer = Schema.Struct({
  draftId: Schema.String,
  status: Schema.Literals(['open', 'accepted', 'rejected']),
})
const decodeAnswer = Schema.decodeUnknownOption(DraftAnswer)

/** Secret-shaped strings never leave in a draft, whatever the model wrote. */
const scrub = (text: string) =>
  text
    .replaceAll(/[\w.+-]+@[\w-]+\.[\w.-]+/gu, '[email]')
    .replaceAll(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][\w-]{10,}\b/gu, '[secret]')
    .replaceAll(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted]')

/** The first JSON object in a model answer. */
const jsonObject = (text: string): string | undefined => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start === -1 || end <= start ? undefined : text.slice(start, end + 1)
}

const transcriptText = (messages: readonly TranscriptMessage[]): string =>
  messages
    .map((message) => `${message.role === 'user' ? (message.author ?? 'owner') : 'agent'}: ${message.text}`)
    .join('\n\n')
    .slice(-MAX_TRANSCRIPT)

const yamlString = (value: string) => JSON.stringify(value.replaceAll(/\s+/gu, ' ').trim())

export type LearnOutcome = 'skipped' | 'none' | 'duplicate' | 'drafted' | 'failed'

/** Log only the bounded learner outcome; transcript, skill body and draft content never enter this line. */
export const logLearnOutcome = (conversation: ConversationId, outcome: LearnOutcome): void => {
  writeLine('info', {
    event: 'skill-learner',
    conversation: String(conversation),
    kind: outcome,
  })
}

/** What the learner keeps and asks: its draft log, the skills state and library, and the cheap model. */
export type LearnerDeps = {
  readonly drafts: DraftLog
  readonly state: SkillState
  readonly skills: Skills['Service']
  readonly model: CheapModel
}

/** What the learner's steps share: its own parts, the connections and the owner's grants. */
type Teacher = LearnerDeps & {
  readonly connections: McpConnections['Service']
  readonly grants: McpGrants['Service']
}

const signalled = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal })
const allowed = (teacher: Teacher, connectionId: string, tool: string) =>
  Effect.map(teacher.grants.policy(connectionId, tool), Option.isSome)

/** A skill source that takes drafts and whose draft tool the owner allowed. */
const draftServer = (teacher: Teacher, preferred: string | undefined, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    const sources = yield* teacher.skills.sources()
    const ordered = preferred !== undefined && sources.includes(preferred) ? [preferred] : sources
    for (const connectionId of ordered) {
      if (!(yield* allowed(teacher, connectionId, DRAFT_TOOL))) continue
      const takes = yield* teacher.connections.connect(connectionId, signalled(signal)).pipe(
        Effect.map((snapshot) => snapshot.tools.some((tool) => tool.name === DRAFT_TOOL)),
        // expected: an unreachable server takes no draft now; the next answer asks it again
        Effect.catch(() => Effect.succeed(false)),
      )
      if (takes) return connectionId
    }
    return undefined
  })

/** Refreshes the status of open drafts from the library, so a decided draft no longer blocks the next one. */
const refresh = (teacher: Teacher, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    for (const row of teacher.drafts.open(5)) {
      const draftId = row.draftId
      if (draftId === undefined || !(yield* allowed(teacher, row.connectionId, DRAFT_STATUS_TOOL))) continue
      const status = yield* teacher.connections
        .callTool(row.connectionId, DRAFT_STATUS_TOOL, { draftId }, { caller: 'model', ...signalled(signal) })
        .pipe(
          Effect.map((result) => Option.getOrUndefined(decodeAnswer(result.structuredContent))?.status),
          // expected: a status that cannot be read now is checked again next time
          Effect.catch(() => Effect.succeed(undefined)),
        )
      const now = yield* Clock.currentTimeMillis
      if (status !== undefined && status !== 'open')
        yield* Effect.sync(() => teacher.drafts.update(row.contentHash, { status }, now))
    }
  })

/** Hands one draft to the library; `undefined` when it did not take it. */
const submit = (
  teacher: Teacher,
  connectionId: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) =>
  teacher.connections.callTool(connectionId, DRAFT_TOOL, args, { caller: 'model', ...signalled(signal) }).pipe(
    Effect.map((result) =>
      result.isError === true ? undefined : Option.getOrUndefined(decodeAnswer(result.structuredContent)),
    ),
    // expected: a draft the library did not take is forgotten, and the outcome is `failed`
    Effect.catch(() => Effect.succeed(undefined)),
  )

/** The skill a draft improves and its name; `undefined` when an improvement names no skill this server served. */
const targetOf = (
  connectionId: string,
  decision: Exclude<Decision, { action: 'none' }>,
  used: ReturnType<SkillState['activations']>,
): { readonly name: string; readonly baseUri: string | undefined } | undefined => {
  if (decision.action === 'new') return { name: decision.name, baseUri: undefined }
  const base = used.find((item) => `${item.connectionId}:${String(item.entry.frontmatter['name'])}` === decision.skill)
  if (base === undefined || base.connectionId !== connectionId) return undefined
  return { name: String(base.entry.frontmatter['name']), baseUri: base.entry.uri }
}

/** Proposes `decision` to `connectionId`'s library as one draft, unless the same or a rejected one is known. */
const draft = (
  teacher: Teacher,
  connectionId: string,
  decision: Exclude<Decision, { action: 'none' }>,
  used: ReturnType<SkillState['activations']>,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const { drafts } = teacher
    const target = targetOf(connectionId, decision, used)
    if (target === undefined) return 'failed'
    const { name, baseUri } = target
    if (drafts.blocked(connectionId, name, baseUri)) return 'duplicate'
    const text = `---\nname: ${name}\ndescription: ${yamlString(scrub(decision.description))}\n---\n\n${scrub(decision.body).trim()}\n`
    const contentHash = yield* Effect.tryPromise(() =>
      digestOf(new TextEncoder().encode(`${connectionId}\n${baseUri ?? ''}\n${text}`)),
    )
    if (drafts.known(contentHash)) return 'duplicate'
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sync(() =>
      drafts.add({ contentHash, connectionId, name, baseUri, draftId: undefined, status: 'open' }, now),
    )
    const args = {
      operationId: `learn-${contentHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
      name,
      files: [{ path: 'SKILL.md', text }],
      ...(baseUri === undefined ? {} : { base: baseUri }),
      evidence: scrub(decision.evidence),
    }
    const taken = yield* submit(teacher, connectionId, args, signal)
    // A draft the library never took must not block the next one.
    if (taken === undefined) {
      yield* Effect.sync(() => drafts.forget(contentHash))
      return 'failed'
    }
    const later = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => drafts.update(contentHash, { draftId: taken.draftId, status: taken.status }, later))
    return 'drafted'
  })

/** The conversation's latest messages, when the owner's last one corrects or asks to keep something; else none. */
const lesson = (sessionId: string) =>
  Effect.gen(function* () {
    const conversation = yield* PiSessions.use((sessions) => sessions.conversation(sessionId))
    if (Option.isNone(conversation)) return undefined
    const messages = yield* Effect.tryPromise(() => recentMessages(conversation.value, 8))
    const lastUser = messages.findLast((message) => message.role === 'user')
    return lastUser !== undefined && SIGNAL.test(lastUser.text) ? messages : undefined
  })

/** The cheap model's decision on the exchange, given the skills used; `undefined` when it answered no JSON. */
const decide = (
  teacher: Teacher,
  messages: readonly TranscriptMessage[],
  used: ReturnType<SkillState['activations']>,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const usedSkills = used
      .map((item) => `- ${item.connectionId}:${String(item.entry.frontmatter['name'])} (${item.entry.uri})`)
      .join('\n')
    const prompt = `Skills used in this conversation:\n${usedSkills || '(none)'}\n\nLatest exchange:\n${transcriptText(messages)}`
    const answer = yield* Effect.tryPromise(() => teacher.model.complete(SYSTEM, prompt, 2000, signal))
    const json = jsonObject(answer)
    if (json === undefined) return undefined
    return yield* Effect.try(() => decodeDecision(json))
  })

/**
 * Considers the newest exchange of a conversation. Cheap checks first: a signal in the owner's last message, a
 * library that takes drafts, today's cap. Only then the model, and only an actual procedure becomes a draft.
 */
const considered = (teacher: Teacher, id: ConversationId, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const capped = teacher.drafts.countSince(now - DAY_MS) >= DRAFTS_PER_DAY
    if (capped || (yield* teacher.skills.sources()).length === 0) return 'skipped'
    const sessionId = String(id)
    const messages = yield* lesson(sessionId)
    if (messages === undefined) return 'skipped'
    const used = teacher.state
      .activations(sessionId)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)
      .slice(0, 3)
    const server = yield* draftServer(teacher, used[0]?.connectionId, signal)
    if (server === undefined) return 'skipped'
    yield* refresh(teacher, signal)
    const decision = yield* decide(teacher, messages, used, signal)
    if (decision === undefined) return 'failed'
    if (decision.action === 'none') return 'none'
    return yield* draft(teacher, server, decision, used, signal)
  })

/**
 * The skill learner over the agent's MCP connections and grants: it calls the library's draft tools like any other
 * tool, only where the owner granted them. One consideration per conversation runs at a time; another asked meanwhile
 * is `skipped`. Any failure is the `failed` outcome, which the outcome line records.
 */
export const makeLearner = Effect.fnUntraced(function* (deps: LearnerDeps) {
  const teacher: Teacher = { ...deps, connections: yield* McpConnections, grants: yield* McpGrants }
  const sessions = yield* PiSessions
  const flights = yield* SingleFlight
  return Learner.of({
    consider: Effect.fn('Learner.consider')(function* (conversation: ConversationId, signal?: AbortSignal) {
      const outcome = yield* flights.skip(
        `skills.learn:${String(conversation)}`,
        considered(teacher, conversation, signal).pipe(
          Effect.map((done): LearnOutcome => done),
          // expected: any failure is the `failed` outcome, which the outcome line records
          Effect.catch(() => Effect.succeed<LearnOutcome>('failed')),
          Effect.provideService(PiSessions, sessions),
        ),
      )
      return Option.getOrElse(outcome, (): LearnOutcome => 'skipped')
    }),
  })
})
