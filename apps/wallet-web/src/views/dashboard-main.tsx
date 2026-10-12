import {
  type DepositAddress,
  type DepositRequest,
  type DepositStatus,
  type Operation,
  type OperationCheck,
  TOOLS,
} from '@goblin/wallet/contract'
import type { App } from '@modelcontextprotocol/ext-apps'
import { useCallback, useMemo, useState } from 'react'
import { Dashboard } from './dashboard.tsx'
import { checkOf, depositOf, depositStatusOf, recentOf, refusalOf, statusOf } from './decode.ts'
import type { FundActions } from './fund.tsx'
import { ViewFrame, ViewStatus } from './frame.tsx'
import { mount } from './mount.tsx'
import { useWalletApp } from './use-wallet-app.ts'

/** Asks the wallet, through the host, for a deposit address that lands as USDC.e with the agent on Tempo. */
async function quoteDeposit(app: App | null, request: DepositRequest): Promise<DepositAddress> {
  if (app === null) throw new Error('The wallet is not connected to its host yet.')
  const answer = await app.callServerTool({ name: TOOLS.addFunds, arguments: { ...request } })
  const deposit = depositOf(answer)
  if (answer.isError === true || deposit === undefined)
    throw new Error(refusalOf(answer) ?? 'No deposit address just now. Try again.')
  return deposit
}

/** Where a deposit address stands, as Relay tells the wallet. */
async function depositProgress(app: App | null, depositAddress: string): Promise<DepositStatus> {
  if (app === null) throw new Error('The wallet is not connected to its host yet.')
  const answer = await app.callServerTool({
    name: TOOLS.addFundsStatus,
    arguments: { deposit_address: depositAddress },
  })
  const found = depositStatusOf(answer)
  if (answer.isError === true || found === undefined) throw new Error(refusalOf(answer) ?? 'Relay did not answer.')
  return found
}

function DashboardView() {
  const { app, error, context, result, cancelled, refusedLink } = useWalletApp('Goblin Wallet')
  const [refreshed, setRefreshed] = useState<{ readonly from: unknown; readonly result: typeof result }>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string>()
  // A refresh only stands until the host sends a newer result of its own.
  const shown = refreshed !== undefined && refreshed.from === result ? refreshed.result : result
  const status = statusOf(shown)

  const refresh = useCallback(async () => {
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
  }, [app, result])

  // Stable across renders, so a deposit in flight keeps one follow timer.
  const fund = useMemo<FundActions>(
    () => ({
      quote: (request) => quoteDeposit(app, request),
      progress: (depositAddress) => depositProgress(app, depositAddress),
      refresh: () => void refresh(),
    }),
    [app, refresh],
  )

  /** Asks the wallet to check an uncertain operation against the chain, then reads the status again. Never pays. */
  async function check(operation: Operation): Promise<OperationCheck> {
    if (app === null) throw new Error('The wallet is not connected to its host yet.')
    const answer = await app.callServerTool({ name: TOOLS.operationCheck, arguments: { operation_id: operation.id } })
    const found = checkOf(answer)
    if (answer.isError === true || found === undefined)
      throw new Error(refusalOf(answer) ?? 'The wallet did not answer the check.')
    // The status follows what the check settled or released; its own failure shows beside Refresh.
    await refresh()
    return found
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
          refusedLink={refusedLink}
          onCheck={check}
          fund={fund}
          fullscreen={context?.displayMode === 'fullscreen'}
          onRefresh={() => void refresh()}
          // Only a host that offers both places can move the view; on a host's own page it already fills the pane.
          onToggleFullscreen={
            (['inline', 'fullscreen'] as const).every((mode) => context?.availableDisplayModes?.includes(mode))
              ? () => void toggleFullscreen()
              : undefined
          }
        />
      )}
    </ViewFrame>
  )
}

mount(<DashboardView />)
