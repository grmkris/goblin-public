import type { NotificationView } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { applyWorkspaceChanges, setFeedStatus, workspaceQueries } from '../lib/workspace/sync.ts'

/** Notifications on the owner API (ADR 0041). The workspace feed carries them (`useNotifications`). */
export const noticeKeys = {
  all: ['notices'] as const,
  read: ['notices', 'read'] as const,
}

const now = () => Math.floor(Date.now() / 1000)

/**
 * The owner read notifications `ids` in Activity: they show read at once, and the server keeps the mark. A mark the
 * server did not keep shows them unread again and says so in the feed's status.
 */
export const readNotificationsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, ids: readonly string[]) => api.notices.read({ payload: { ids } }),
  }),
  mutationKey: noticeKeys.read,
  onMutate: (ids, { client }): readonly NotificationView[] => {
    const wanted = new Set(ids)
    const shown = (client.getQueryData(workspaceQueries.notifications.queryKey) ?? []).filter(
      (notification) => wanted.has(notification.id) && notification.readAt === null,
    )
    const readAt = now()
    applyWorkspaceChanges(
      client,
      shown.map((notification) => ({ type: 'notification' as const, notification: { ...notification, readAt } })),
    )
    return shown
  },
  onError: (failure, _ids, shown, { client }) => {
    if (shown !== undefined)
      applyWorkspaceChanges(
        client,
        shown.map((notification) => ({ type: 'notification' as const, notification })),
      )
    setFeedStatus(client, messageOf(failure, 'mark them read'))
  },
})
