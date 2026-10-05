import type { WorkspaceFeed } from '../workspace/feed.ts'
import type { MemberController } from './controller.ts'
import type { MemberPrincipal } from '../env.ts'
import { sseResponse } from '../http/sse.ts'
import type { ConversationActivity, WorkspaceChange, WorkspaceSnapshot } from '@purrable/contracts'

/** Never serialize the owner's raw feed to a member. Rebuild a live, filtered view for each notification. */
export function memberWorkspaceResponse(
  feed: WorkspaceFeed,
  members: MemberController,
  principal: MemberPrincipal,
): Response {
  return sseResponse((send, finish) => {
    let closed = false
    let pending = Promise.resolve()
    const activity = new Map<string, ConversationActivity>()
    const refresh = () => {
      pending = pending.then(async () => {
        const conversations = await members.list(principal)
        const main = await members.main(principal)
        const allowed = new Set(conversations.map((view) => view.id))
        const filtered = [...activity.values()].flatMap((item) => {
          if (item.id === '1') return []
          const id = item.id === main ? '1' : item.id
          return allowed.has(id) ? [{ ...item, id }] : []
        })
        await members.access.verify(principal)
        if (!closed) send('snapshot', { conversations, activity: filtered })
      })
      void pending.catch(() => {
        closed = true
        clearInterval(timer)
        finish()
      })
    }
    const timer = setInterval(refresh, 5000)
    const opened = feed.open((event, data) => {
      if (event === 'snapshot') {
        // SAFETY: WorkspaceFeed's event discriminates its corresponding snapshot payload.
        const snapshot = data as WorkspaceSnapshot
        activity.clear()
        for (const item of snapshot.activity) activity.set(item.id, item)
      } else {
        // SAFETY: WorkspaceFeed's change event always carries its contract-validated change array.
        for (const item of data as readonly WorkspaceChange[]) {
          if (item.type !== 'activity') continue
          if (item.activity.state === 'idle') activity.delete(item.activity.id)
          else activity.set(item.activity.id, item.activity)
        }
      }
      refresh()
    })
    void opened.catch(() => {
      closed = true
      clearInterval(timer)
      finish()
    })
    return async () => {
      closed = true
      clearInterval(timer)
      await (
        await opened.catch(() => undefined)
      )?.()
    }
  })
}
