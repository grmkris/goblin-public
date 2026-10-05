import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { WorkspaceSurface } from '../components/workspace-surface.tsx'

/**
 * The owner's panes, at `/` and at `/c/<id>`. The URL names only the focused conversation; which panes are open and
 * where is this device's arrangement (`components/workspace.tsx`).
 */
export const Route = createFileRoute('/_workspace')({ component: Workspace })

function Workspace() {
  return (
    <OwnerGate>
      <WorkspaceSurface />
    </OwnerGate>
  )
}
