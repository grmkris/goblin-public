import type { ConversationView } from '@goblin/contracts'
import * as Context from 'effect/Context'

/**
 * The registry of the owner's chats as Promise code takes it: a new Topic Conversation, a notice that chats changed,
 * and the owner's views of them. Programs use `Conversations` (chats/service.ts); this view runs its methods.
 */
export type ConversationRegistry = {
  readonly openConversation: () => Promise<string>
  /** Tells `conversations.changed` about chats a write changed, on the caller's stack. */
  readonly touched: (ids: readonly string[]) => void
  readonly list: () => Promise<readonly ConversationView[]>
  readonly view: (id: string) => Promise<ConversationView | undefined>
}

/**
 * The registry's Promise view, made with the conversation services (`layers/conversation.ts`) for the Topic ports and
 * the workspace feed, which call it from their own Promise work.
 */
export class ConversationsInstance extends Context.Service<ConversationsInstance, ConversationRegistry>()(
  'goblin/conversations/ConversationsInstance',
) {}
