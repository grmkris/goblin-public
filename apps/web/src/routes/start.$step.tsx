import { createFileRoute, redirect } from '@tanstack/react-router'
import { ONBOARDING_STEPS, type OnboardingStep } from '@goblin/contracts'
import { OwnerGate } from '../components/owner-gate.tsx'
import { StartPage, type StartSearch } from '../components/start/start.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery } from '../mcp/queries.ts'
import { onboardingQuery } from '../onboarding/queries.ts'

const isStep = (value: string): value is OnboardingStep => ONBOARDING_STEPS.some((step) => step === value)

/** A sign-in's answer, as Connections forwards it: plain tokens only. */
const parseReturn = (search: Record<string, unknown>): StartSearch => {
  const token = (key: string) => {
    const value = search[key]
    return typeof value === 'string' && /^[\w.:-]{1,128}$/u.test(value) ? { [key]: value } : {}
  }
  return { ...token('connected'), ...token('error'), ...token('ref') }
}

/** One step of first-run Start (`/start/<step>`), before the chats; Start's state and the servers load first. */
export const Route = createFileRoute('/start/$step')({
  validateSearch: parseReturn,
  beforeLoad: ({ params }) => {
    if (!isStep(params.step)) throw redirect({ to: '/start/$step', params: { step: 'wallet' } })
  },
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, onboardingQuery),
      primeOwnerRead(context.queryClient, serversQuery),
    ])
  },
  component: StartRoute,
})

function StartRoute() {
  const { step } = Route.useParams()
  const search = Route.useSearch()
  return (
    <OwnerGate planRequired={false}>
      <StartPage step={isStep(step) ? step : 'wallet'} search={search} />
    </OwnerGate>
  )
}
