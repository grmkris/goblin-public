import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { Subscribe } from '../components/billing.tsx'
import { parseSubscribeSearch } from '../lib/subscribe-search.ts'
export const Route = createFileRoute('/subscribe')({ validateSearch: parseSubscribeSearch, component: SubscribePage })
function SubscribePage() {
  const success = useMatch({ from: '/subscribe/success', shouldThrow: false })
  const { return: back } = Route.useSearch()
  return <OwnerGate planRequired={false}>{success ? <Outlet /> : <Subscribe back={back} />}</OwnerGate>
}
