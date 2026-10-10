import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { ChatId } from '../ids.ts'
import { MemoryStatus } from '../agent.ts'
import { ApiErrors } from './errors.ts'

/**
 * The memory of a chat's Conversation (ADR 0032). Paths are relative to the API's `/api` prefix.
 *
 * - `status`: `GET /api/agent/memory?chat=<id>`, what the Conversation `chat` sits under remembers (Personal's without
 *   `chat`): its messages, and how many of them its newest view summarizes. An unknown chat is not found; a `chat`
 *   that is not a chat id is invalid input.
 */
export class MemoryGroup extends HttpApiGroup.make('memory').add(
  HttpApiEndpoint.get('status', '/agent/memory', {
    query: { chat: Schema.optional(ChatId) },
    success: MemoryStatus,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }),
) {}
