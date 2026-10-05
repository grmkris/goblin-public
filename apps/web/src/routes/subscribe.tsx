import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { Subscribe } from '../components/billing.tsx'
export const Route = createFileRoute('/subscribe')({ component: SubscribePage })
function SubscribePage() {
  const success = useMatch({ from: '/subscribe/success', shouldThrow: false })
  return <OwnerGate planRequired={false}>{success ? <Outlet /> : <Subscribe />}</OwnerGate>
}
