import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createFixtureApi } from './api/fixture-api.ts'
import { createHttpApi } from './api/http-api.ts'
import { ApiProvider } from './api/queries.tsx'
import { App } from './app/app.tsx'
import { useAuth } from './app/auth.tsx'
import { FixtureAuthProvider } from './app/fixture-auth.tsx'
import { PrivyAuthProvider } from './app/privy-auth.tsx'
import { PrivyRoot } from './privy/index.ts'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing_root_element')

/** `?fixtures` (or `?fixtures=fresh` for the empty wallet) shows the demo data instead of calling the API. */
const fixtureMode = new URLSearchParams(window.location.search).get('fixtures')

function Fixtures() {
  const world = useMemo(() => createFixtureApi(fixtureMode === 'fresh' ? 'fresh' : 'ready'), [])
  return (
    <FixtureAuthProvider onUpgrade={world.simulate.upgrade} onAllowance={world.simulate.allowance}>
      <ApiProvider api={world}>
        <App />
      </ApiProvider>
    </FixtureAuthProvider>
  )
}

function Live() {
  const { getToken } = useAuth()
  const api = useMemo(() => createHttpApi(getToken), [getToken])
  return (
    <ApiProvider api={api}>
      <App />
    </ApiProvider>
  )
}

createRoot(container).render(
  <StrictMode>
    {fixtureMode === null ? (
      <PrivyRoot>
        <PrivyAuthProvider>
          <Live />
        </PrivyAuthProvider>
      </PrivyRoot>
    ) : (
      <Fixtures />
    )}
  </StrictMode>,
)
