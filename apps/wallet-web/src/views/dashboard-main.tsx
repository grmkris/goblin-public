import { ViewFrame, ViewStatus } from './frame.tsx'
import { mount } from './mount.tsx'
import { useWalletApp } from './use-wallet-app.ts'

function Dashboard() {
  const { error } = useWalletApp('Goblin Wallet')
  return (
    <ViewFrame>
      <ViewStatus error={error}>Loading your wallet…</ViewStatus>
    </ViewFrame>
  )
}

mount(<Dashboard />)
