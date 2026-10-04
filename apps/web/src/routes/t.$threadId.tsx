import { createFileRoute } from '@tanstack/react-router'
import { Chat } from '../components/chat.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

/** A side thread or a subagent: the same chat, on that conversation. */
export const Route = createFileRoute('/t/$threadId')({ component: Thread })
function Thread() {
  const { threadId } = Route.useParams()
  return (
    <OwnerGate>
      <Chat thread={threadId} />
    </OwnerGate>
  )
}
