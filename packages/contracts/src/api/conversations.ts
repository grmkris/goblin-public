import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { ChatId } from '../ids.ts'
import { ComposerOptions } from '../composer.ts'
import {
  ConversationView,
  CreateConversation,
  MessageReceipt,
  SendMessage,
  StartThread,
  StartedThread,
  StopConversation,
  UpdateConversation,
} from '../conversations.ts'
import { ConversationQueue, QueueRemoval, QueueRemovalResult } from '../queue.ts'
import { SourceUse } from '../retrieval.ts'
import { MoveReceipt, MoveToThread } from '../threads.ts'
import { ApiErrors } from './errors.ts'
import { RenewsResident } from './resident.ts'
import { EventStream } from './stream.ts'

/** The chat a path names: a logical chat id of 1 to 12 digits. */
const params = { id: ChatId }

/**
 * A page of a chat's history before entry `before`, oldest first, and whether older entries remain. The entries are
 * Pi's own records, as Pi writes them; the web reads them with its transcript projection.
 */
const ConversationHistory = Schema.Struct({ entries: Schema.Array(Schema.Unknown), more: Schema.Boolean })

/** `?before=<entry>`: a positive safe integer. */
const HistoryQuery = {
  before: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
}

/**
 * The owner's conversations and threads (ADRs 0030, 0032, 0034). Paths are relative to the API's `/api` prefix; every
 * endpoint can also answer owner admission's failures (`OwnerAdmission` in `owner.ts`), and `error` names the ones the
 * endpoint itself produces.
 *
 * - `create`: `POST /api/conversations`, 201: the thread operation without a message (`CreateConversation`), a Thread
 *   branched from an entry of an open chat or an empty one.
 * - `update`: `PATCH /api/conversations/:id` renames, closes or reopens, or pins a subagent open.
 * - `submit`: `POST …/:id/messages`, 202 with Pi's receipt: the owner's message, or an ask of the Personas it tags.
 * - `startThread`: `POST …/:id/threads`, 201: the thread operation (`StartThread`): one call makes the Thread once per
 *   operation id and sends the message as its first, answered there.
 * - `move`: `POST …/:id/move`: Move to thread, as its receipt. The same operation id finds the same move.
 * - `stop`: `POST …/:id/stop`: Stop in the chat; `stopped` says whether anything was running.
 * - `queue` / `removeQueued`: `GET` and `DELETE …/:id/queue`: the owner's queued inputs, and withdrawing one.
 * - `markRead`: `PUT …/:id/read`: the owner has seen the newest reply.
 * - `composer`: `GET …/:id/composer`: what the composer can tag in the chat.
 * - `snapshot`: `GET …/:id/snapshot`: the chat's Pi snapshot, as JSON.
 * - `history`: `GET …/:id/history?before=`: a page of older entries.
 * - `sources`: `GET …/:id/sources`: what retrieval gave the chat's answers (ADR 0035), newest first.
 * - `events`: `GET …/:id/events`, server-sent: Pi's `snapshot`, then a `batch` per commit, until the browser goes away.
 *   A chat keeps its Pi session, so this is its session's stream. It does not renew resident authority.
 */
export class ConversationsGroup extends HttpApiGroup.make('conversations').add(
  HttpApiEndpoint.post('create', '/conversations', {
    payload: CreateConversation,
    success: ConversationView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.patch('update', '/conversations/:id', {
    params,
    payload: UpdateConversation,
    success: ConversationView,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.post('submit', '/conversations/:id/messages', {
    params,
    payload: SendMessage,
    success: MessageReceipt.pipe(HttpApiSchema.status(202)),
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.budgetExhausted],
  }),
  HttpApiEndpoint.post('startThread', '/conversations/:id/threads', {
    params,
    payload: StartThread,
    success: StartedThread.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput, ApiErrors.budgetExhausted],
  }),
  HttpApiEndpoint.post('move', '/conversations/:id/move', {
    params,
    payload: MoveToThread,
    success: MoveReceipt,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.post('stop', '/conversations/:id/stop', {
    params,
    payload: StopConversation,
    success: Schema.Struct({ stopped: Schema.Boolean }),
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('queue', '/conversations/:id/queue', {
    params,
    success: ConversationQueue,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.delete('removeQueued', '/conversations/:id/queue', {
    params,
    payload: QueueRemoval,
    success: QueueRemovalResult,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.put('markRead', '/conversations/:id/read', {
    params,
    success: Schema.Struct({ read: Schema.Boolean }),
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('composer', '/conversations/:id/composer', {
    params,
    success: ComposerOptions,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.get('snapshot', '/conversations/:id/snapshot', {
    params,
    success: Schema.JsonObject,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('history', '/conversations/:id/history', {
    params,
    query: HistoryQuery,
    success: ConversationHistory,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.get('sources', '/conversations/:id/sources', {
    params,
    success: Schema.Array(SourceUse),
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.get('events', '/conversations/:id/events', {
    params,
    success: EventStream,
    error: [ApiErrors.notFound],
  }).annotate(RenewsResident, false),
) {}
