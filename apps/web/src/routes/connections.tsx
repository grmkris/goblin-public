import { createFileRoute } from '@tanstack/react-router'
import { Connections } from '../components/connections.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'

export const Route = createFileRoute('/connections')({ component: ConnectionsPage })
function ConnectionsPage() {
  return (
    <OwnerGate>
      <PageBar title="Connections" />
      <div className="shell">
        <Connections />
      </div>
    </OwnerGate>
  )
}
