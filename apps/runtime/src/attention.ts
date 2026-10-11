import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { type Attention, NotInTopic, itemLabel } from '@goblin/contracts'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import { Predicate } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appMcpApprovals } from './storage/mcp-approvals.ts'
import { appAgentApps, appAgentPowers } from './storage/schema.ts'

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
type Ask = { readonly kind: Attention['kind']; readonly label: string }

/** The first question's prompt, for a question's label. */
const questionLabel = (details: Fields): string =>
  text(record(Array.isArray(details.questions) ? details.questions[0] : undefined)?.prompt) ?? 'A question'

/**
 * goblin's own markers that ask the owner, by the `kind` of a tool result's details: `ask_user`'s questions,
 * `mcp_call`'s grant request, and something the Topic's setup does not hold (`pi/setup.ts`).
 */
const MARKERS: Readonly<Record<string, (details: Fields, result: ToolResult) => Ask | undefined>> = {
  question: (details, result) =>
    result.isError || result.toolName !== 'ask_user' ? undefined : { kind: 'question', label: questionLabel(details) },
  'grant-required': (details, result) =>
    result.isError
      ? { kind: 'grant', label: `${text(details.connectionId) ?? ''} · ${text(details.name) ?? ''}` }
      : undefined,
  'not-in-topic': (details, result) => {
    const add = result.isError ? addLabel(details) : undefined
    return add === undefined ? undefined : { kind: 'setup', label: add }
  },
}

/**
 * The owner ask a tool result carries, from goblin's own markers only: a remote result always carries an `origin`, so
 * a server's content cannot raise one. Held MCP calls are read from their store instead (`storedAsks`).
 */
function askOf(entry: EntryRecord): Attention | undefined {
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
      }
  }
  return undefined
}

/**
 * What still waits on the owner in a chat's own entries (oldest first): the asks since its newest user message, which
 * settles every ask before it, as the web's cards do (`lib/interactions.ts`).
 */
export function openAsks(entries: readonly EntryRecord[], before: readonly Attention[] = []): readonly Attention[] {
  let open = [...before]
  for (const entry of entries) {
    if (entry.kind === 'pi.user') open = []
    const ask = askOf(entry)
    if (ask !== undefined) open.push(ask)
  }
  return open
}

/**
 * What waits on the owner in a chat from goblin's own stores: its held MCP calls still pending (by the chat's current
 * Pi session, where they were held), and the powers its agent apps' running releases ask for that the owner has not
 * answered. Times in seconds.
 */
export function storedAsks<RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  chat: { readonly id: string; readonly session: string },
  now: number,
): readonly Attention[] {
  const approvals = db
    .select()
    .from(appMcpApprovals)
    .where(
      and(
        eq(appMcpApprovals.sessionId, chat.session),
        eq(appMcpApprovals.state, 'pending'),
        gt(appMcpApprovals.expiresAt, now),
      ),
    )
    .all()
    .map((row): Attention => ({
      kind: 'approval',
      since: Math.floor(row.createdAt / 1000),
      label: label(`${row.connectionId} · ${row.name}`),
    }))
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
  return [...approvals, ...powers]
}
