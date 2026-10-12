import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { ActivityPage } from '../components/shell/pages/activity-page.tsx'

export const Route = createFileRoute('/activity')({ component: ActivityRoute })
function ActivityRoute() {
  return (
    <OwnerGate startRequired>
      <PageBar title="Activity" />
      <div className="shell">
        <ActivityPage />
      </div>
    </OwnerGate>
  )
}
