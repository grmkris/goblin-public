import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { Settings } from '../components/settings.tsx'

export const Route = createFileRoute('/settings')({ component: SettingsPage })
function SettingsPage() {
  return (
    <OwnerGate>
      <Settings />
    </OwnerGate>
  )
}
