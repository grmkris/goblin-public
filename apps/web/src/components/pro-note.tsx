// Where the owner gets Pro for a hand-over (ADR 0012, amended 2026-10-12), and comes back to the page they were on.
import { useRouterState } from '@tanstack/react-router'

/**
 * Whether the owner may pick a hand-over: on Pro (however it is paid, or an override), and while the plan is still
 * being read, so Pro never flickers locked. Only an account known to have no plan says no; the agent checks the plan
 * either way.
 */
export const hasHandOver = (state: { readonly active: boolean } | undefined): boolean =>
  state === undefined || state.active

/** "Handing … is part of Pro", with Get Pro: `/subscribe`, returning here. */
export function ProNote({ children }: { readonly children: string }) {
  const here = useRouterState({ select: (router) => router.location.href })
  return (
    <p className="server-note">
      {children}{' '}
      <a className="cause-link" href={`/subscribe?return=${encodeURIComponent(here)}`}>
        Get Pro
      </a>
    </p>
  )
}
