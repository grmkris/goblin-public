import { ViewFrame, ViewStatus } from './frame.tsx'
import { mount } from './mount.tsx'
import { useWalletApp } from './use-wallet-app.ts'

function Receipt() {
  const { error } = useWalletApp('Goblin Wallet receipt')
  return (
    <ViewFrame>
      <ViewStatus error={error}>Loading the receipt…</ViewStatus>
    </ViewFrame>
  )
}

mount(<Receipt />)
