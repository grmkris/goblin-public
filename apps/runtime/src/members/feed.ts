import type { WorkspaceFeed } from '../workspace/feed.ts'
import type { MemberController } from './controller.ts'
import type { MemberPrincipal } from '../env.ts'
import { sseResponse } from '../http/sse.ts'

/** Never serialize the owner's raw feed to a member. Rebuild a live, filtered view for each notification. */
export function memberWorkspaceResponse(
  feed: WorkspaceFeed,
  members: MemberController,
  principal: MemberPrincipal,
): Response {
  return sseResponse((send, finish) => {
    let closed = false
    let pending = Promise.resolve()
    const refresh = () => {
      pending = pending.then(async () => {
        const conversations = await members.list(principal)
        await members.access.verify(principal)
        if (!closed) send('snapshot', { conversations, activity: [] })
      })
      void pending.catch(() => {
        closed = true
        clearInterval(timer)
        finish()
      })
    }
    const timer = setInterval(refresh, 5000)
    const opened = feed.open(() => refresh())
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
