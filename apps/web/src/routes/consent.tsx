import { createFileRoute } from '@tanstack/react-router'
import { Consent } from '../components/consent.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

export const Route = createFileRoute('/consent')({ component: ConsentPage })
function ConsentPage() {
  return (
    <OwnerGate>
      <Consent />
    </OwnerGate>
  )
}
