import type { CreateConversation, MoveToThread, QueueRemoval, SendMessage, UpdateConversation } from '@goblin/contracts'
import { infiniteQueryOptions, queryOptions, skipToken } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { isNumber, record } from '../lib/values.ts'
import { withOperation } from '../lib/query/api-query.ts'

/** Every conversation read: keys are `['conversations', kind, …input]`, so `['conversations']` reaches them all. */
export const conversationKeys = {
  sources: (id: string) => ['conversations', 'sources', id] as const,
  /** Undefined while nothing asks for it (the picker is closed): the read waits. */
  composer: (id: string | undefined) => ['conversations', 'composer', id] as const,
  composers: ['conversations', 'composer'] as const,
  /** The pages before entry `start`; undefined while the snapshot starts at the beginning. */
  history: (id: string, start: number | undefined) => ['conversations', 'history', id, start] as const,
}

/** What retrieval gave chat `id`'s answers, newest first (ADR 0035). */
export const sourcesQuery = (id: string) =>
  owner.apiQuery({
    queryKey: conversationKeys.sources(id),
    queryFn: (api) => api.conversations.sources({ params: { id } }),
  })

/** What the composer of chat `id` can tag (`/` and `@`). */
const composerQuery = (id: string) =>
  owner.apiQuery({
    queryKey: conversationKeys.composer(id),
    queryFn: (api) => api.conversations.composer({ params: { id } }),
  })

/** The composer's references, read only while `id` is given (its picker is open). */
export const openComposerQuery = (id: string | undefined) =>
  queryOptions({
    queryKey: conversationKeys.composer(id),
    queryFn: id === undefined ? skipToken : composerQuery(id).queryFn,
  })

/**
 * Chat `id`'s history before what its snapshot shows, a page at a time: the first page is the one before entry
 * `start`, each next one the page before the oldest entry so far, while older entries remain.
 */
export const historyQuery = (id: string, start: number | undefined) =>
  infiniteQueryOptions({
    queryKey: conversationKeys.history(id, start),
    queryFn:
      start === undefined
        ? skipToken
        : ({ pageParam, signal }) =>
            owner.run((api) => api.conversations.history({ params: { id }, query: { before: pageParam } }), signal),
    initialPageParam: start ?? 1,
    getNextPageParam: (page) => {
      const oldest = record(page.entries[0])?.id
      return page.more && isNumber(oldest) ? oldest : undefined
    },
  })

/**
 * The reads chat `id`'s live stream makes itself (`lib/conversation-stream.ts`, an SSE store beside the cache): its
 * Pi snapshot on every (re)connect, and the content of its queued inputs.
 */
export const streamReads = (id: string) => ({
  snapshot: (signal: AbortSignal) => owner.run((api) => api.conversations.snapshot({ params: { id } }), signal),
  queue: (signal: AbortSignal) => owner.run((api) => api.conversations.queue({ params: { id } }), signal),
})

/** The owner's message to chat `id`, as its operation: a retry with the same id is the same message. */
type Submission = { readonly id: string; readonly message: SendMessage }

/** Sends the owner's message; the chat's stream shows it. */
export const submitMutation = owner.apiMutation({
  mutationFn: (api, { id, message }: Submission) =>
    api.conversations.submit({ params: { id }, payload: message }).pipe(withOperation(message.operationId)),
})

/** The same send, for a caller outside a component (an App's Continue). */
export const sendMessage = ({ id, message }: Submission) =>
  owner.run((api) =>
    api.conversations.submit({ params: { id }, payload: message }).pipe(withOperation(message.operationId)),
  )

/** The owner's message as the head of a new Thread of chat `id`, answered there (ADR 0034). */
export const startThreadMutation = owner.apiMutation({
  mutationFn: (api, { id, message }: Submission) =>
    api.conversations.startThread({ params: { id }, payload: message }).pipe(withOperation(message.operationId)),
})

/** Move to thread: the owner's message `entry` of chat `id`, and the turn it started. */
export const moveMutation = owner.apiMutation({
  mutationFn: (api, { id, move }: { readonly id: string; readonly move: MoveToThread }) =>
    api.conversations.move({ params: { id }, payload: move }).pipe(withOperation(move.operationId)),
})

/** Stop in chat `id`. */
export const stopMutation = owner.apiMutation({
  mutationFn: (api, id: string) => api.conversations.stop({ params: { id }, payload: {} }),
})

/** Withdraws a queued input of chat `id`; the chat's stream reads its queue again. */
export const removeQueuedMutation = owner.apiMutation({
  mutationFn: (api, { id, removal }: { readonly id: string; readonly removal: QueueRemoval }) =>
    api.conversations.removeQueued({ params: { id }, payload: removal }),
})

/** A Thread branched from an entry, or an empty one of a Topic; the workspace feed shows it. */
export const createConversationMutation = owner.apiMutation({
  mutationFn: (api, create: CreateConversation) => api.conversations.create({ payload: create }),
})

/** A chat renamed, closed or reopened, or a subagent kept open; the workspace feed shows it. */
export const updateConversationMutation = owner.apiMutation({
  mutationFn: (api, { id, change }: { readonly id: string; readonly change: UpdateConversation }) =>
    api.conversations.update({ params: { id }, payload: change }),
})

/** The owner has seen chat `id`'s newest reply. */
export const markReadMutation = owner.apiMutation({
  mutationFn: (api, id: string) => api.conversations.markRead({ params: { id } }),
})
