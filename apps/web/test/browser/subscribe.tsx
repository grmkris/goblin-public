import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { BillingCard, Subscribe } from '../../src/components/billing.tsx'
import { PlanNeededCard } from '../../src/components/plan-needed.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/**
 * goblin Pro's surfaces (ADR 0054) from source on a memory router (`?at=/subscribe`): `/subscribe` with the day pass
 * and monthly, Settings' plan card, and the composer's no-plan card as the dock shows it.
 */
const root = createRootRoute({
  component: () => (
    <main className="p-4">
      <Outlet />
    </main>
  ),
})
const subscribe = createRoute({
  getParentRoute: () => root,
  path: '/subscribe',
  component: () => <Subscribe back="/settings" />,
})
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: () => (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <BillingCard />
    </div>
  ),
})
const composer = createRoute({
  getParentRoute: () => root,
  path: '/c/$chatId',
  component: () => (
    <div className="chat-dock mx-auto max-w-xl">
      <div className="dock-cards">
        <PlanNeededCard />
      </div>
    </div>
  ),
})
const at = new URLSearchParams(location.search).get('at') ?? '/subscribe'
const router = createRouter({
  routeTree: root.addChildren([subscribe, settings, composer]),
  history: createMemoryHistory({ initialEntries: [at] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />))
