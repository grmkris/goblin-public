import { useQuery } from '@tanstack/react-query'
import { Navigate, createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { StartSplash } from '../components/start/splash.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { onboardingQuery } from '../onboarding/queries.ts'

/**
 * First-run Start (ADR 0048) opens on the first step still to do, the welcome once all are done; its splash shows
 * until Start's state says which. A state that cannot be read opens the welcome.
 */
export const Route = createFileRoute('/start/')({
  loader: ({ context }) => primeOwnerRead(context.queryClient, onboardingQuery),
  component: StartIndex,
})

function FirstOpenStep() {
  const read = useQuery(onboardingQuery)
  if (read.data === undefined && read.error === null) return <StartSplash />
  const step = read.data?.steps.find((each) => !each.done)?.id ?? 'welcome'
  return <Navigate to="/start/$step" params={{ step }} replace />
}

function StartIndex() {
  return (
    <OwnerGate planRequired={false} pending={<StartSplash />}>
      <FirstOpenStep />
    </OwnerGate>
  )
}
