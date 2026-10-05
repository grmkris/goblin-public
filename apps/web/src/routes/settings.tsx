import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { Settings } from '../components/settings.tsx'

export const Route = createFileRoute('/settings')({ component: SettingsPage })
function SettingsPage() {
  return (
    <OwnerGate>
      <PageBar title="Settings" />
      <div className="shell">
        <Settings />
      </div>
    </OwnerGate>
  )
}
