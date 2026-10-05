import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { WorkspaceSurface } from '../components/workspace-surface.tsx'

/**
 * The owner's panes, at `/`, `/c/<id>` and `/a/<id>`. The URL names only the focused conversation or App; which panes
 * are open and where is this device's arrangement (`components/workspace.tsx`).
 */
export const Route = createFileRoute('/_workspace')({ component: Workspace })

function Workspace() {
  return (
    <OwnerGate>
      <WorkspaceSurface />
    </OwnerGate>
  )
}
