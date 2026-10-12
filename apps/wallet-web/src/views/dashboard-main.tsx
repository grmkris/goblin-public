import { TOOLS } from '@goblin/wallet/contract'
import { useState } from 'react'
import { Dashboard } from './dashboard.tsx'
import { recentOf, statusOf } from './decode.ts'
import { ViewFrame, ViewStatus } from './frame.tsx'
import { mount } from './mount.tsx'
import { useWalletApp } from './use-wallet-app.ts'

function DashboardView() {
  const { app, error, context, result, cancelled } = useWalletApp('Goblin Wallet')
  const [refreshed, setRefreshed] = useState<{ readonly from: unknown; readonly result: typeof result }>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string>()
  // A refresh only stands until the host sends a newer result of its own.
  const shown = refreshed !== undefined && refreshed.from === result ? refreshed.result : result
  const status = statusOf(shown)

  async function refresh() {
    if (app === null) return
    setRefreshing(true)
    setRefreshError(undefined)
    try {
      const fresh = await app.callServerTool({ name: TOOLS.status, arguments: {} })
      if (fresh.isError === true || statusOf(fresh) === undefined) throw new Error('The wallet did not answer.')
      setRefreshed({ from: result, result: fresh })
    } catch (failure) {
      // expected: shown beside the refresh button, and the last good figures stay on screen
      setRefreshError(failure instanceof Error ? failure.message : 'Could not refresh.')
    } finally {
      setRefreshing(false)
    }
  }

  async function toggleFullscreen() {
    if (app === null) return
    await app.requestDisplayMode({ mode: context?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen' })
  }

  return (
    <ViewFrame>
      {status === undefined ? (
        <ViewStatus error={error}>{cancelled ? 'The wallet call was cancelled.' : 'Loading your wallet…'}</ViewStatus>
      ) : (
        <Dashboard
          status={status}
          recent={recentOf(shown)}
          refreshing={refreshing}
          refreshError={refreshError}
          fullscreen={context?.displayMode === 'fullscreen'}
          onRefresh={() => void refresh()}
          onToggleFullscreen={
            context?.availableDisplayModes?.includes('fullscreen') === true ? () => void toggleFullscreen() : undefined
          }
        />
      )}
    </ViewFrame>
  )
}

mount(<DashboardView />)
