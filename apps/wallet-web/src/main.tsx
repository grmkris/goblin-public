import { CHAINS } from '@goblin/wallet/chains'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing_root_element')

createRoot(container).render(
  <StrictMode>
    <main className="flex min-h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold">Goblin Wallet</h1>
        <p className="text-muted-foreground">{CHAINS.length} chains known</p>
      </div>
    </main>
  </StrictMode>,
)
