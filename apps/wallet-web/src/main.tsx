import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createFixtureApi } from './api/fixture-api.ts'
import { ApiProvider } from './api/queries.tsx'
import { App } from './app/app.tsx'
import { FixtureAuthProvider } from './app/fixture-auth.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing_root_element')

function Fixtures() {
  const world = useMemo(
    () => createFixtureApi(new URLSearchParams(window.location.search).get('fixtures') === 'fresh' ? 'fresh' : 'ready'),
    [],
  )
  return (
    <FixtureAuthProvider onUpgrade={world.simulate.upgrade} onAllowance={world.simulate.allowance}>
      <ApiProvider api={world}>
        <App />
      </ApiProvider>
    </FixtureAuthProvider>
  )
}

createRoot(container).render(
  <StrictMode>
    <Fixtures />
  </StrictMode>,
)
