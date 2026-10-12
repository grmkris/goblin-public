import { createFileRoute, redirect } from '@tanstack/react-router'

/** First-run Start (ADR 0048) opens on its first step; the page itself takes the owner to the one they are on. */
export const Route = createFileRoute('/start/')({
  beforeLoad: () => {
    throw redirect({ to: '/start/$step', params: { step: 'wallet' } })
  },
})
