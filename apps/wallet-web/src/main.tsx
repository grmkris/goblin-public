import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiProvider } from './api/queries.tsx'
import { createFixtureApi } from './api/fixture-api.ts'
import { App } from './app/app.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing_root_element')

createRoot(container).render(
  <StrictMode>
    <ApiProvider api={createFixtureApi()}>
      <App onSignOut={() => undefined} />
    </ApiProvider>
  </StrictMode>,
)
