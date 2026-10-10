import { mutationOptions } from '@tanstack/react-query'
import { appClosedMutation, keepAppMutation } from '../../apps/queries.ts'
import { markReadMutation, startThreadMutation, updateConversationMutation } from '../../conversations/queries.ts'
import { undoMutation } from '../../organize/queries.ts'
import { createPersonaMutation, updatePersonaMutation } from '../../personas/queries.ts'
import { createTopicMutation, updateTopicMutation } from '../../topics/queries.ts'
import { messageOf } from '../query/app-error.ts'
import { applyWorkspaceChanges, setFeedStatus, workspaceKeys, workspaceQueries, workspaceSync } from './sync.ts'

const now = () => Math.floor(Date.now() / 1000)

/**
 * Keeps the App of call `callId` in a conversation, reopening it if it was closed. It shows once the server answers,
 * and stays as answered until the feed agrees (`lib/workspace/pending-apps.ts`).
 */
export const keepWorkspaceAppMutation = mutationOptions({
  ...keepAppMutation,
  mutationKey: workspaceKeys.apps,
  onSuccess: (app, _keep, _context, { client }) => workspaceSync(client).appAnswered(app),
})

/**
 * Closes a kept App (its iframe goes everywhere, its place offers to show it again), or opens a closed one again. A
 * close shows at once; either stays as the server answered until the feed agrees, over whatever the feed sends
 * meanwhile, and a refused one shows the App as the feed has it.
 */
export const closeWorkspaceAppMutation = mutationOptions({
  ...appClosedMutation,
  mutationKey: workspaceKeys.apps,
  onMutate: ({ id, closed }, { client }) => {
    const shown = client.getQueryData(workspaceQueries.apps.queryKey)?.find((app) => app.id === id)
    if (!closed || shown === undefined) return undefined
    return workspaceSync(client).appStarted({ ...shown, closedAt: now() })
  },
  onError: (_failure, _change, started, { client }) => {
    if (started !== undefined) workspaceSync(client).appRefused(started)
  },
  onSuccess: (app, _change, started, { client }) => workspaceSync(client).appAnswered(app, started),
})

/**
 * The owner has seen conversation `id`'s newest reply: it shows read at once, and the server keeps the mark. A mark the
 * server did not keep says so in the feed's status.
 */
export const markReadWorkspaceMutation = mutationOptions({
  ...markReadMutation,
  onMutate: (id, { client }) => {
    const view = client.getQueryData(workspaceQueries.conversations.queryKey)?.find((each) => each.id === id)
    if (view === undefined) return
    const readAt = Math.max(now(), view.lastReplyAt ?? 0, view.readAt ?? 0)
    applyWorkspaceChanges(client, [{ type: 'conversation', conversation: { ...view, readAt } }])
  },
  onError: (failure, _id, _context, { client }) => setFeedStatus(client, messageOf(failure, 'mark it read')),
})

/** A conversation renamed, closed or reopened, or a subagent kept open: it shows as the server answers. */
export const updateWorkspaceConversationMutation = mutationOptions({
  ...updateConversationMutation,
  onError: (failure, _update, _context, { client }) =>
    setFeedStatus(client, messageOf(failure, 'change the conversation')),
  onSuccess: (conversation, _update, _context, { client }) =>
    applyWorkspaceChanges(client, [{ type: 'conversation', conversation }]),
})

/** A new Topic (the same `operationId` finds the same one): it shows as the server answers. */
export const createWorkspaceTopicMutation = mutationOptions({
  ...createTopicMutation,
  onSuccess: (topic, _create, _context, { client }) => applyWorkspaceChanges(client, [{ type: 'topic', topic }]),
})

/** A Topic renamed, archived or restored, or kept out of search: it shows as the server answers. */
export const updateWorkspaceTopicMutation = mutationOptions({
  ...updateTopicMutation,
  onSuccess: (topic, _update, _context, { client }) => applyWorkspaceChanges(client, [{ type: 'topic', topic }]),
})

/** Undo of an organizing receipt: the receipt shows undone as the server answers; the feed brings what it restored. */
export const undoWorkspaceReceiptMutation = mutationOptions({
  ...undoMutation,
  onSuccess: (receipt, _id, _context, { client }) => applyWorkspaceChanges(client, [{ type: 'receipt', receipt }]),
})

/** The unified thread operation (ADR 0034): the thread it made shows as the server answers. */
export const startWorkspaceThreadMutation = mutationOptions({
  ...startThreadMutation,
  onSuccess: (started, _start, _context, { client }) =>
    applyWorkspaceChanges(client, [{ type: 'conversation', conversation: started.thread }]),
})

/** A new Persona (the same `operationId` finds the same one): it shows as the server answers; its profile reads it. */
export const createWorkspacePersonaMutation = mutationOptions({
  ...createPersonaMutation,
  onSuccess: (persona, create, result, context) => {
    applyWorkspaceChanges(context.client, [{ type: 'persona', persona }])
    return createPersonaMutation.onSuccess?.(persona, create, result, context)
  },
})

/** A new revision of Persona `id`: it shows as the server answers, and its profile reads it again. */
export const updateWorkspacePersonaMutation = (id: number) => {
  const update = updatePersonaMutation(id)
  return mutationOptions({
    ...update,
    onSuccess: (persona, change, result, context) => {
      applyWorkspaceChanges(context.client, [{ type: 'persona', persona }])
      return update.onSuccess?.(persona, change, result, context)
    },
  })
}
