import type {
  CapabilityChange,
  ConversationView,
  CreateConversation,
  SendMessage,
  UpdateConversation,
} from '@goblin/contracts'
import { AppError } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { RpcResult } from '../../src/http/rpc.ts'
import { type AgentFetch, type OwnerClient, ownerApi, workspaceSnapshot } from './owner-api.ts'
import type { PersonalAgentProbe } from './worker.ts'

type Probe = DurableObjectStub<PersonalAgentProbe>

const isAppError = Schema.is(AppError)

/**
 * One owner API call against `agent`, answered in the shape of the owner RPC method it replaces: `{ ok: true, value }`,
 * or `{ ok: false, error }` with the encoded `AppError` (carrying the reference the API stamps on it). A failure the API
 * did not answer (transport, or a body that does not decode) rejects.
 */
export const ownerResult = <A, E>(
  agent: AgentFetch,
  call: (api: OwnerClient) => Effect.Effect<A, E>,
): Promise<RpcResult<A>> =>
  Effect.runPromise(
    Effect.flatMap(ownerApi(agent), call).pipe(
      Effect.map((value): RpcResult<A> => ({ ok: true, value })),
      // expected: the API answered this failure; the checks read it as the RPC method's refusal.
      Effect.catchIf(isAppError, (error) =>
        Effect.succeed<RpcResult<A>>({ ok: false, error: Schema.encodeSync(AppError)(error) }),
      ),
    ),
  )

/** The owner's message into a chat: `POST /api/conversations/:id/messages`. */
export const ownerSend = (
  agent: AgentFetch,
  chat: string,
  input: string,
  operationId: string,
  extra: Omit<SendMessage, 'input' | 'operationId'> = {},
) =>
  ownerResult(agent, (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId, ...extra } }),
  )

/** Every registered chat, closed ones included, as the workspace feed's snapshot lists them. */
export const workspaceConversations = async (agent: AgentFetch): Promise<readonly ConversationView[]> =>
  (await workspaceSnapshot(await agent.fetch(new Request('https://agent/api/workspace/events')))).conversations

/** A Thread, empty or branched from an entry: `POST /api/conversations`. */
export const ownerCreate = (agent: AgentFetch, input: CreateConversation) =>
  ownerResult(agent, (api) => api.conversations.create({ payload: input }))

/** Rename, close or reopen, or pin a subagent open: `PATCH /api/conversations/:id`. */
export const ownerUpdate = (agent: AgentFetch, chat: string, change: UpdateConversation) =>
  ownerResult(agent, (api) => api.conversations.update({ params: { id: chat }, payload: change }))

/** The owner has seen a chat's newest reply: `PUT /api/conversations/:id/read`. */
export const ownerMarkRead = (agent: AgentFetch, chat: string) =>
  ownerResult(agent, (api) => api.conversations.markRead({ params: { id: chat } }))

/** A chat's switches: `GET /api/conversations/:id/capabilities`. */
export const ownerCapabilities = (agent: AgentFetch, chat: string) =>
  ownerResult(agent, (api) => api.conversations.capabilities({ params: { id: chat } }))

/** A change to a chat's switches: `PATCH /api/conversations/:id/capabilities`. */
export const ownerSetCapability = (agent: AgentFetch, chat: string, change: CapabilityChange) =>
  ownerResult(agent, (api) =>
    // The client takes each variant of the change on its own.
    'reset' in change
      ? api.conversations.setCapability({ params: { id: chat }, payload: change })
      : api.conversations.setCapability({ params: { id: chat }, payload: change }),
  )

/** A Pi entry as these probes read it. */
const EntrySchema = Schema.Struct({
  id: Schema.Finite,
  kind: Schema.String,
  head: Schema.optional(Schema.Finite),
  data: Schema.optional(Schema.Unknown),
  model: Schema.optional(
    Schema.Array(Schema.Struct({ content: Schema.optional(Schema.Unknown), details: Schema.optional(Schema.Unknown) })),
  ),
})
export type Entry = typeof EntrySchema.Type
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.optionalKey(Schema.Array(EntrySchema)) }),
)

/** A conversation's Pi snapshot through the owner API (`GET /api/conversations/:id/snapshot`), as JSON. */
export const ownerSnapshot = (agent: AgentFetch, chat: string) =>
  Effect.runPromise(Effect.flatMap(ownerApi(agent), (api) => api.conversations.snapshot({ params: { id: chat } })))

/** A conversation's snapshot, as far as its entries. */
export const snapshotOf = async (agent: Probe, session: string): Promise<{ readonly entries?: readonly Entry[] }> =>
  decodeEntries(await ownerSnapshot(agent, session))

/** Entries as `kind: content`, one line per model message. */
export const linesOf = (records: readonly Entry[]) =>
  records.flatMap((entry) => (entry.model ?? []).map((message) => `${entry.kind}: ${JSON.stringify(message.content)}`))

/** A conversation's history before entry `before`, through the owner API (`GET …/history?before=`). */
export const historyOf = async (
  agent: Probe,
  session: string,
  before = 2 ** 31,
): Promise<{ readonly entries?: readonly Entry[] }> =>
  decodeEntries(
    await Effect.runPromise(
      Effect.flatMap(ownerApi(agent), (api) =>
        api.conversations.history({ params: { id: session }, query: { before } }),
      ),
    ),
  )

/** A conversation's newest entries as people read them, in order, whatever the model's context starts with now. */
export const transcript = async (agent: Probe, session: string): Promise<string[]> =>
  linesOf((await historyOf(agent, session)).entries ?? [])

/**
 * Reads every 20 ms until `done` holds, for up to `ms` (5 s by default); the last read either way (background work
 * settles late).
 */
export async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 5000): Promise<A> {
  let value = await read()
  for (let attempt = 0; attempt < ms / 20 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

/** The agent's conversations, once `done` holds for them. */
export const threadsUntil = (agent: Probe, done: (views: readonly ConversationView[]) => boolean, ms?: number) =>
  until(() => workspaceConversations(agent), done, ms)

/** One owner message into a conversation, settled. */
export async function exchange(agent: Probe, session: string, text: string, id: string) {
  await ownerSend(agent, session, text, id)
  return agent.settle(session, id)
}
