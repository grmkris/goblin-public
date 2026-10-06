import { createFileRoute } from '@tanstack/react-router'
import { AppsPage } from '../components/apps-page.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'

/** The owner's agent apps (ADR 0021). */
export const Route = createFileRoute('/apps/')({ component: AppsRoute })
function AppsRoute() {
  return (
    <OwnerGate>
      <PageBar title="Apps" />
      <div className="shell">
        <AppsPage />
      </div>
    </OwnerGate>
  )
}
