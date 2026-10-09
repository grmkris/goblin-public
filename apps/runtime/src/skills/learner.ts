// The skill learner: after a final answer that followed a correction or a request to remember how something was done,
// a cheap model decides whether the exchange teaches a reusable procedure, and if so the agent proposes a draft to the
// owner's skills library through its `skill_draft` tool. The owner reviews every draft there; nothing here publishes
// a skill. Facts about the owner stay in memory and are not skills. Drafts are capped per day, never repeated, and a
// rejected one is not proposed again.
import type { ConversationId } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { McpConnectionManager } from '../mcp/connection.ts'
import type { CheapModel } from '../memory/model.ts'
import { writeLine } from '../observability/logger.ts'
import { BACKGROUND } from '../pi/context.ts'
import { type TranscriptMessage, recentMessages } from '../pi/transcript.ts'
import type { SkillLibrary } from './library.ts'
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

export class SkillLearner {
  readonly #drafts: DraftLog
  readonly #harness: PiHarness
  readonly #manager: McpConnectionManager
  readonly #library: SkillLibrary
  readonly #state: SkillState
  readonly #model: CheapModel
  readonly #allows: (serverId: string, tool: string) => boolean
  readonly #now: () => number
  readonly #busy = new Set<string>()

  constructor(deps: {
    readonly drafts: DraftLog
    readonly harness: PiHarness
    readonly manager: McpConnectionManager
    readonly library: SkillLibrary
    readonly state: SkillState
    readonly model: CheapModel
    /** The owner's grant for a library tool: the learner calls the draft tools like any other tool. */
    readonly allows: (serverId: string, tool: string) => boolean
    readonly now: () => number
  }) {
    this.#drafts = deps.drafts
    this.#harness = deps.harness
    this.#manager = deps.manager
    this.#library = deps.library
    this.#state = deps.state
    this.#model = deps.model
    this.#allows = deps.allows
    this.#now = deps.now
  }

  /** A skill source that takes drafts and whose draft tool the owner allowed. */
  async #draftServer(preferred: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    const sources = this.#library.sources()
    const ordered = preferred !== undefined && sources.includes(preferred) ? [preferred] : sources
    for (const serverId of ordered) {
      if (!this.#allows(serverId, DRAFT_TOOL)) continue
      try {
        const snapshot = await this.#manager.connect(serverId, signal === undefined ? {} : { signal })
        if (snapshot.tools.some((tool) => tool.name === DRAFT_TOOL)) return serverId
      } catch {
        // expected: an unreachable server takes no draft now; the next answer asks it again
      }
    }
    return undefined
  }

  /** Refresh the status of open drafts from the library, so a decided draft no longer blocks the next one. */
  async #refresh(signal?: AbortSignal): Promise<void> {
    for (const row of this.#drafts.open(5)) {
      if (row.draftId === undefined || !this.#allows(row.serverId, DRAFT_STATUS_TOOL)) continue
      try {
        const result = await this.#manager.callTool(
          row.serverId,
          DRAFT_STATUS_TOOL,
          { draftId: row.draftId },
          { caller: 'model', ...(signal === undefined ? {} : { signal }) },
        )
        const status = Option.getOrUndefined(decodeAnswer(result.structuredContent))?.status
        if (status !== undefined && status !== 'open') this.#drafts.update(row.contentHash, { status }, this.#now())
      } catch {
        // expected: a status that cannot be read now is checked again next time
      }
    }
  }

  /**
   * Consider the newest exchange of a conversation. Cheap checks first: a signal in the owner's last message, a
   * library that takes drafts, today's cap. Only then the model, and only an actual procedure becomes a draft.
   */
  async consider(conversation: ConversationId, signal?: AbortSignal): Promise<LearnOutcome> {
    const sessionId = String(conversation)
    if (this.#busy.has(sessionId)) return 'skipped'
    this.#busy.add(sessionId)
    try {
      return await this.#consider(conversation, signal)
    } catch {
      // expected: any failure is the `failed` outcome, which the outcome line records
      return 'failed'
    } finally {
      this.#busy.delete(sessionId)
    }
  }

  async #consider(id: ConversationId, signal?: AbortSignal): Promise<LearnOutcome> {
    if (this.#library.sources().length === 0 || this.#drafts.countSince(this.#now() - DAY_MS) >= DRAFTS_PER_DAY)
      return 'skipped'
    const sessionId = String(id)
    const conversation = await (await this.#harness.pi()).conversation(id, BACKGROUND)
    if (conversation === undefined) return 'skipped'
    const messages = await recentMessages(conversation, 8)
    const lastUser = messages.findLast((message) => message.role === 'user')
    if (lastUser === undefined || !SIGNAL.test(lastUser.text)) return 'skipped'
    const used = this.#state
      .activations(sessionId)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)
      .slice(0, 3)
    const server = await this.#draftServer(used[0]?.serverId, signal)
    if (server === undefined) return 'skipped'
    await this.#refresh(signal)
    const skills = used
      .map((item) => `- ${item.serverId}:${String(item.entry.frontmatter['name'])} (${item.entry.uri})`)
      .join('\n')
    const answer = await this.#model.complete(
      SYSTEM,
      `Skills used in this conversation:\n${skills || '(none)'}\n\nLatest exchange:\n${transcriptText(messages)}`,
      2000,
      signal,
    )
    const json = jsonObject(answer)
    if (json === undefined) return 'failed'
    const decision: Decision = decodeDecision(json)
    if (decision.action === 'none') return 'none'
    return this.#draft(server, decision, used, signal)
  }

  /** The skill a draft improves and its name; `undefined` when an improvement names no skill this server served. */
  #target(
    serverId: string,
    decision: Exclude<Decision, { action: 'none' }>,
    used: ReturnType<SkillState['activations']>,
  ): { readonly name: string; readonly baseUri: string | undefined } | undefined {
    if (decision.action === 'new') return { name: decision.name, baseUri: undefined }
    const base = used.find((item) => `${item.serverId}:${String(item.entry.frontmatter['name'])}` === decision.skill)
    if (base === undefined || base.serverId !== serverId) return undefined
    return { name: String(base.entry.frontmatter['name']), baseUri: base.entry.uri }
  }

  async #draft(
    serverId: string,
    decision: Exclude<Decision, { action: 'none' }>,
    used: ReturnType<SkillState['activations']>,
    signal: AbortSignal | undefined,
  ): Promise<LearnOutcome> {
    const target = this.#target(serverId, decision, used)
    if (target === undefined) return 'failed'
    const { name, baseUri } = target
    if (this.#drafts.blocked(serverId, name, baseUri)) return 'duplicate'
    const text = `---\nname: ${name}\ndescription: ${yamlString(scrub(decision.description))}\n---\n\n${scrub(decision.body).trim()}\n`
    const contentHash = await digestOf(new TextEncoder().encode(`${serverId}\n${baseUri ?? ''}\n${text}`))
    if (this.#drafts.known(contentHash)) return 'duplicate'
    this.#drafts.add({ contentHash, serverId, name, baseUri, draftId: undefined, status: 'open' }, this.#now())
    const draft = await this.#submit(
      serverId,
      {
        operationId: `learn-${contentHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
        name,
        files: [{ path: 'SKILL.md', text }],
        ...(baseUri === undefined ? {} : { base: baseUri }),
        evidence: scrub(decision.evidence),
      },
      signal,
    )
    if (draft === undefined) {
      // A draft the library never took must not block the next one.
      this.#drafts.forget(contentHash)
      return 'failed'
    }
    this.#drafts.update(contentHash, { draftId: draft.draftId, status: draft.status }, this.#now())
    return 'drafted'
  }

  /** Hand one draft to the library; `undefined` when it did not take it. */
  async #submit(serverId: string, args: Record<string, unknown>, signal: AbortSignal | undefined) {
    try {
      const result = await this.#manager.callTool(serverId, DRAFT_TOOL, args, {
        caller: 'model',
        ...(signal === undefined ? {} : { signal }),
      })
      return result.isError === true ? undefined : Option.getOrUndefined(decodeAnswer(result.structuredContent))
    } catch {
      // expected: a draft the library did not take is forgotten, and the outcome is `failed`
      return undefined
    }
  }
}
