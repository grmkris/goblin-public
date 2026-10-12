import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { type Attention, NotInTopic, PersonaAnswerData, itemLabel } from '@goblin/contracts'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import { Predicate } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appMcpApprovals } from './storage/mcp-approvals.ts'
import { appMcpUrlRequests } from './storage/mcp-url-requests.ts'
import { appPersonaChats } from './storage/personas.ts'
import { appAgentApps, appAgentPowers, appConversations, appMcpLabels } from './storage/schema.ts'

const LABEL = 200
const label = (text: string): string => (text.length > LABEL ? `${text.slice(0, LABEL - 1)}…` : text)
type Fields = { readonly [x: PropertyKey]: unknown }
const record = (value: unknown): Fields | undefined => (Predicate.isReadonlyObject(value) ? value : undefined)
const text = (value: unknown): string | undefined => (Predicate.isString(value) ? value : undefined)

const notInTopic = Schema.decodeUnknownOption(NotInTopic)

/** How a refusal outside the Topic's setup reads: what to add, and where. */
const addLabel = (details: Fields): string | undefined =>
  Option.getOrUndefined(
    Option.map(notInTopic(details), ({ target, topic }) => `Add ${itemLabel(target)} to #${topic.name}`),
  )

type ToolResult = Extract<Message, { role: 'toolResult' }>

/**
 * An ask about one connection's tool (a grant, more access): the connection's id and what follows it in the label, so
 * the chat's description can name the connection by its label (`labelled`).
 */
type About = { readonly connection: string; readonly what: string }
type Ask = { readonly kind: Attention['kind']; readonly label: string; readonly about?: About }

/** An ask in a chat as attention, keeping what it is about until the chat's description names it. */
export type OpenAsk = Attention & { readonly about?: About }

/** An ask about `connection`: labelled by its id until `labelled` names it. */
const about = (connection: string, what: string): Pick<Ask, 'label' | 'about'> => ({
  label: label(`${connection} · ${what}`),
  about: { connection, what },
})

/** Every connection's label the owner gave it (ADR 0041), by its id. */
export const connectionLabels = <RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>): ReadonlyMap<string, string> =>
  new Map(
    db
      .select()
      .from(appMcpLabels)
      .all()
      .map((row) => [row.connectionId, row.label]),
  )

/** The asks with each connection named by the owner's label (ADR 0041); the id stays where none is known. */
export const labelled = (asks: readonly OpenAsk[], labels: ReadonlyMap<string, string>): Attention[] =>
  asks.map(({ about: target, ...ask }) =>
    target === undefined
      ? ask
      : { ...ask, label: label(`${labels.get(target.connection) ?? target.connection} · ${target.what}`) },
  )

/** The first question's prompt, for a question's label. */
const questionLabel = (details: Fields): string =>
  text(record(Array.isArray(details.questions) ? details.questions[0] : undefined)?.prompt) ?? 'A question'

/**
 * goblin's own markers that ask the owner, by the `kind` of a tool result's details: `ask_user`'s questions,
 * `mcp_call`'s grant request and its request for more access (ADR 0042), and something the Topic's setup does not hold
 * (`pi/setup.ts`).
 */
const MARKERS: Readonly<Record<string, (details: Fields, result: ToolResult) => Ask | undefined>> = {
  question: (details, result) =>
    result.isError || result.toolName !== 'ask_user' ? undefined : { kind: 'question', label: questionLabel(details) },
  'grant-required': (details, result) =>
    result.isError
      ? { kind: 'grant', ...about(text(details.connectionId) ?? '', text(details.name) ?? '') }
      : undefined,
  'scope-required': (details, result) =>
    result.isError ? { kind: 'access', ...about(text(details.connectionId) ?? '', 'more access') } : undefined,
  'connect-required': (details, result) =>
    result.isError ? { kind: 'connect', ...about(text(details.connectionId) ?? '', 'sign in') } : undefined,
  'not-in-topic': (details, result) => {
    const add = result.isError ? addLabel(details) : undefined
    return add === undefined ? undefined : { kind: 'setup', label: add }
  },
}

/**
 * The owner ask a tool result carries, from goblin's own markers only: a remote result always carries an `origin`, so
 * a server's content cannot raise one. Held MCP calls are read from their store instead (`storedAsks`).
 */
function askOf(entry: EntryRecord): OpenAsk | undefined {
  for (const message of entry.model ?? []) {
    if (message.role !== 'toolResult') continue
    const details = record(message.details)
    const ask =
      details === undefined || 'origin' in details ? undefined : MARKERS[text(details.kind) ?? '']?.(details, message)
    if (ask !== undefined)
      return {
        kind: ask.kind,
        since: Math.floor(message.timestamp / 1000),
        entry: Number(entry.id),
        label: label(ask.label),
        ...(ask.about === undefined ? {} : { about: ask.about }),
      }
  }
  return undefined
}

/**
 * A call goblin held for the owner, by its marker: an approval of exact arguments, a tool to allow, a URL request to
 * finish, or a sign-in with more access (ADR 0042).
 */
export type HeldCall = {
  readonly kind: 'approval' | 'grant' | 'url' | 'access' | 'connect'
  readonly approvalId?: string
  readonly requestId?: string
  readonly scope?: string
  readonly connectionId: string
  readonly name: string
}

/**
 * The call a tool result held for the owner, from goblin's own markers only (`approval-required`, `grant-required`,
 * `url-required`, `scope-required`); a remote result always carries an `origin`, so a server's content can never hold
 * one.
 */
export function heldCall(entry: EntryRecord): HeldCall | undefined {
  for (const message of entry.model ?? []) {
    if (message.role !== 'toolResult' || !message.isError) continue
    const details = record(message.details)
    const held = details === undefined || 'origin' in details ? undefined : holdOf(details)
    if (held !== undefined) return held
  }
  return undefined
}

/**
 * The call one marker holds, by its `kind`: an approval names its held call, a URL request its request, a sign-in with
 * more access the scope asked for, a grant only the tool.
 */
const HOLDS: Readonly<
  Record<string, (details: Fields, call: Pick<HeldCall, 'connectionId' | 'name'>) => HeldCall | undefined>
> = {
  'grant-required': (_details, call) => ({ kind: 'grant', ...call }),
  'approval-required': (details, call) => {
    const approvalId = text(details.approvalId)
    return approvalId === undefined ? undefined : { kind: 'approval', approvalId, ...call }
  },
  'url-required': (details, call) => {
    const requestId = text(details.requestId)
    return requestId === undefined ? undefined : { kind: 'url', requestId, ...call }
  },
  'scope-required': (details, call) => ({ kind: 'access', scope: (text(details.scope) ?? '').slice(0, 512), ...call }),
  'connect-required': (_details, call) => ({ kind: 'connect', ...call }),
}

function holdOf(details: Fields): HeldCall | undefined {
  const connectionId = text(details.connectionId)
  const name = text(details.name)
  const hold = Object.hasOwn(HOLDS, text(details.kind) ?? '') ? HOLDS[text(details.kind) ?? ''] : undefined
  if (connectionId === undefined || name === undefined || hold === undefined) return undefined
  return hold(details, { connectionId, name })
}

const personaAnswer = Schema.decodeUnknownOption(PersonaAnswerData)

/**
 * A Persona's answer in a chat's entries (`app.persona`, ADR 0041): its Persona, and the tool it waits for the owner to
 * allow, as an ask. Its held calls are read from their store (`storedAsks`); its next answer settles its ask.
 */
function personaAsk(entry: EntryRecord): { readonly persona: number; readonly ask?: OpenAsk } | undefined {
  if (entry.kind !== 'app.persona') return undefined
  const answer = Option.getOrUndefined(personaAnswer(entry.data))
  if (answer === undefined) return undefined
  const { hold } = answer
  // Held calls and URL requests are read from their stores; a grant or a sign-in waits in the answer itself.
  if (hold?.kind !== 'grant' && hold?.kind !== 'access' && hold?.kind !== 'connect') return { persona: answer.persona }
  const since = Math.floor((entry.model?.[0]?.timestamp ?? 0) / 1000)
  const ask: OpenAsk = {
    kind: hold.kind,
    since,
    entry: Number(entry.id),
    ...about(hold.connectionId, { grant: hold.name, access: 'more access', connect: 'sign in' }[hold.kind]),
    persona: answer.persona,
  }
  return { persona: answer.persona, ask }
}

/**
 * What still waits on the owner in a chat's own entries (oldest first): the asks since its newest user message, which
 * settles every ask before it, as the web's cards do (`lib/interactions.ts`); a Persona's ask until its next answer.
 */
export function openAsks(entries: readonly EntryRecord[], before: readonly OpenAsk[] = []): readonly OpenAsk[] {
  let open = [...before]
  for (const entry of entries) {
    if (entry.kind === 'pi.user') open = []
    const answered = personaAsk(entry)
    if (answered !== undefined) {
      open = open.filter((ask) => ask.persona !== answered.persona)
      if (answered.ask !== undefined) open.push(answered.ask)
    }
    const ask = askOf(entry)
    if (ask !== undefined) open.push(ask)
  }
  return open
}

/**
 * What waits on the owner in a chat from goblin's own stores: its held MCP calls and URL requests still pending (by the
 * chat's current Pi session, where they were held, and those of the Persona forks answering in it), and the powers its
 * agent apps' running releases ask for that the owner has not answered. Times in seconds.
 */
export function storedAsks<RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  chat: { readonly id: string; readonly session: string },
  now: number,
): readonly Attention[] {
  // A Persona's fork holds its calls in its own session (ADR 0041); they wait on the owner in the chat it answers in.
  const forks = db
    .select({ session: appConversations.piSession, persona: appPersonaChats.personaId })
    .from(appConversations)
    .innerJoin(appPersonaChats, eq(appPersonaChats.chatId, appConversations.chatId))
    .where(and(eq(appConversations.parentSession, chat.id), eq(appConversations.role, 'persona')))
    .all()
  const personaOf = new Map(forks.flatMap((fork) => (fork.session === null ? [] : [[fork.session, fork.persona]])))
  const approvals = db
    .select({ row: appMcpApprovals, label: appMcpLabels.label })
    .from(appMcpApprovals)
    .leftJoin(appMcpLabels, eq(appMcpLabels.connectionId, appMcpApprovals.connectionId))
    .where(
      and(
        inArray(appMcpApprovals.sessionId, [chat.session, ...personaOf.keys()]),
        eq(appMcpApprovals.state, 'pending'),
        gt(appMcpApprovals.expiresAt, now),
      ),
    )
    .all()
    .map(({ row, label: connection }): Attention => {
      const persona = row.sessionId === null ? undefined : personaOf.get(row.sessionId)
      return {
        kind: 'approval',
        since: Math.floor(row.createdAt / 1000),
        label: label(`${connection ?? row.connectionId} · ${row.name}`),
        ...(persona === undefined ? {} : { persona }),
      }
    })
  const powers = db
    .select({ app: appAgentApps, power: appAgentPowers })
    .from(appAgentPowers)
    .innerJoin(appAgentApps, eq(appAgentApps.name, appAgentPowers.app))
    .where(
      and(
        inArray(appAgentApps.homeSession, [chat.id, chat.session]),
        eq(appAgentPowers.requestedBy, appAgentApps.activeRelease),
        isNull(appAgentPowers.approvedAt),
        isNull(appAgentPowers.revokedAt),
      ),
    )
    .all()
    .map(({ app, power }): Attention => ({
      kind: 'app-power',
      since: Math.floor(app.updatedAt / 1000),
      label: label(`${app.title} asks for ${power.kind} ${power.target}`),
    }))
  const links = db
    .select({ row: appMcpUrlRequests, label: appMcpLabels.label })
    .from(appMcpUrlRequests)
    .leftJoin(appMcpLabels, eq(appMcpLabels.connectionId, appMcpUrlRequests.connectionId))
    .where(
      and(
        inArray(appMcpUrlRequests.sessionId, [chat.session, ...personaOf.keys()]),
        eq(appMcpUrlRequests.state, 'pending'),
        gt(appMcpUrlRequests.expiresAt, now),
      ),
    )
    .all()
    .map(({ row, label: connection }): Attention => {
      const persona = personaOf.get(row.sessionId)
      return {
        kind: 'link',
        since: Math.floor(row.createdAt / 1000),
        label: label(`${connection ?? row.connectionId} · ${row.name}`),
        ...(persona === undefined ? {} : { persona }),
      }
    })
  return [...approvals, ...links, ...powers]
}
