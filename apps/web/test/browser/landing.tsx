import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { Landing } from '../../src/components/landing/landing.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** goblin's landing as `/` renders it for a visitor who is signed out, and the channel it leaves for once signed in. */
const root = createRootRoute({
  component: () => (
    <main className="landing-root">
      <Outlet />
    </main>
  ),
})
const home = createRoute({ getParentRoute: () => root, path: '/', component: Landing })
const channel = createRoute({
  getParentRoute: () => root,
  path: '/c/$chatId',
  component: function Channel() {
    const { chatId } = channel.useParams()
    return <p id="channel">Channel {chatId}</p>
  },
})
const router = createRouter({
  routeTree: root.addChildren([home, channel]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />))
