import { createFileRoute } from '@tanstack/react-router'
import { Connections } from '../components/connections.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

export const Route = createFileRoute('/connections')({ component: ConnectionsPage })
function ConnectionsPage() {
  return (
    <OwnerGate>
      <Connections />
    </OwnerGate>
  )
}
