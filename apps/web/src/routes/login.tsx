import { createFileRoute } from '@tanstack/react-router'
import { Authentication } from '../components/authentication.tsx'

/** Better Auth's login page for MCP client authorization; plain sign-in otherwise. */
export const Route = createFileRoute('/login')({ component: Login })
function Login() {
  return <Authentication onAuthenticated={() => window.location.assign('/')} />
}
