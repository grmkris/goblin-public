import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { Authentication } from '../components/authentication.tsx'

/** Better Auth's login page for MCP client authorization; plain sign-in otherwise. */
export const Route = createFileRoute('/login')({ component: Login })
function Login() {
  // `?new=1` (the landing's Meet your goblin) opens on creating an account. Read from the raw query, untouched: an
  // MCP client's authorization arrives here with Better Auth's signed query, which must reach it as it was sent.
  const creating = useRouterState({
    select: (state) => new URLSearchParams(state.location.searchStr).get('new') === '1',
  })
  return <Authentication creating={creating} onAuthenticated={() => window.location.assign('/')} />
}
