import type { ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { GoblinMark } from '@goblin/ui'
import {
  BellIcon,
  HouseIcon,
  LayoutGridIcon,
  ListChecksIcon,
  LogOutIcon,
  MessagesSquareIcon,
  PlugIcon,
  SettingsIcon,
} from 'lucide-react'
import { railCounts } from '../../lib/rail.ts'
import { signOut } from '../../lib/session.tsx'
import { useActivities, useApps, useConversations, useInvocations } from '../../lib/workspace/hooks.ts'

/** Whether a path is one of the channel's places: a channel and its threads, an App's page, a Persona's profile. */
export const atHome = (path: string): boolean =>
  path === '/' || path.startsWith('/c/') || path.startsWith('/a/') || path.startsWith('/p/')

/** What a stop on the rail shows: its icon on a rounded square with a count of what waits there, its name under it. */
function Stop({ label, icon, count }: { readonly label: string; readonly icon: ReactNode; readonly count?: number }) {
  return (
    <>
      <span className="rail-icon">
        {icon}
        {count !== undefined && count > 0 && (
          <span className="rail-count" aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span className="rail-label">{label}</span>
      {count !== undefined && count > 0 && <span className="sr-only">, {count}</span>}
    </>
  )
}

const current = (active: boolean) => (active ? ('page' as const) : undefined)

/**
 * The rail: Home (the channel this tab showed last) first, then the app's other places, and at its foot the Apps, Connections, Settings and
 * Sign out. A stop's name is under its icon, as on Slack's rail; the current place is filled.
 */
export function Rail() {
  const path = useRouterState({ select: (router) => router.location.pathname })
  const at = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
  const counts = railCounts(useConversations(), useApps(), useActivities(), useInvocations())
  return (
    <nav className="shell-rail" aria-label="Places">
      <Link to="/" className="rail-brand" aria-label="goblin home">
        <GoblinMark />
      </Link>
      <Link to="/" className="rail-item" aria-current={current(atHome(path))}>
        <Stop label="Home" icon={<HouseIcon aria-hidden />} />
      </Link>
      <Link to="/threads" className="rail-item" aria-current={current(at('/threads'))}>
        <Stop label="Threads" icon={<MessagesSquareIcon aria-hidden />} count={counts.threads} />
      </Link>
      <Link to="/activity" className="rail-item" aria-current={current(at('/activity'))}>
        <Stop label="Activity" icon={<BellIcon aria-hidden />} count={counts.activity} />
      </Link>
      <Link to="/tasks" className="rail-item" aria-current={current(at('/tasks'))}>
        <Stop label="Tasks" icon={<ListChecksIcon aria-hidden />} count={counts.tasks} />
      </Link>
      <span className="rail-spacer" />
      <Link to="/apps" className="rail-item" aria-current={current(at('/apps'))}>
        <Stop label="Apps" icon={<LayoutGridIcon aria-hidden />} />
      </Link>
      <Link to="/connections" className="rail-item" aria-current={current(at('/connections'))}>
        <Stop label="Connections" icon={<PlugIcon aria-hidden />} />
      </Link>
      <Link to="/settings" className="rail-item" aria-current={current(at('/settings'))}>
        <Stop label="Settings" icon={<SettingsIcon aria-hidden />} />
      </Link>
      <button type="button" className="rail-item" onClick={() => void signOut()}>
        <Stop label="Sign out" icon={<LogOutIcon aria-hidden />} />
      </button>
    </nav>
  )
}
