import { mutationOptions } from '@tanstack/react-query'
import { appClosedMutation, keepAppMutation } from '../../apps/queries.ts'
import { markReadMutation, updateConversationMutation } from '../../conversations/queries.ts'
import { messageOf } from '../query/app-error.ts'
import { AppOverlay, applyWorkspaceChanges, setFeedStatus, workspaceKeys, workspaceQueries } from './sync.ts'

const now = () => Math.floor(Date.now() / 1000)

/** Keeps the App of call `callId` in a conversation, reopening it if it was closed; it shows once the server answers. */
export const keepWorkspaceAppMutation = mutationOptions({
  ...keepAppMutation,
  mutationKey: workspaceKeys.apps,
  onSuccess: (app, _keep, _overlay, { client }) => applyWorkspaceChanges(client, [{ type: 'app', app }]),
})

/**
 * Closes a kept App (its iframe goes everywhere, its place offers to show it again), or opens a closed one again. A
 * close shows at once, over whatever the feed sends meanwhile, and the App comes back as it was if the server refuses.
 */
export const closeWorkspaceAppMutation = mutationOptions({
  ...appClosedMutation,
  mutationKey: workspaceKeys.apps,
  onMutate: ({ id, closed }, { client }) => {
    const before = client.getQueryData(workspaceQueries.apps.queryKey)?.find((app) => app.id === id)
    if (!closed || before === undefined) return undefined
    const overlay = new AppOverlay({ ...before, closedAt: now() }, before)
    applyWorkspaceChanges(client, [{ type: 'app', app: overlay.shown }])
    return overlay
  },
  onError: (_failure, _change, overlay, { client }) => {
    overlay?.settle()
    if (overlay !== undefined) applyWorkspaceChanges(client, [{ type: 'app', app: overlay.before }])
  },
  onSuccess: (app, _change, overlay, { client }) => {
    overlay?.settle()
    applyWorkspaceChanges(client, [{ type: 'app', app }])
  },
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
