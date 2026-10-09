import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { ThreadsPage } from '../components/shell/pages/threads-page.tsx'

export const Route = createFileRoute('/threads')({ component: ThreadsRoute })
function ThreadsRoute() {
  return (
    <OwnerGate>
      <PageBar title="Threads" />
      <div className="shell">
        <ThreadsPage />
      </div>
    </OwnerGate>
  )
}
