import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerSource } from '@goblin/contracts'
import { goblinWalletOf, heldOf } from '../lib/pro.ts'
import { addAndConnectMutation, connectMutation, serverStatusQuery, serversQuery } from './queries.ts'

/**
 * The owner's label of a connection by its id (ADR 0041), for anything that names one: the id until the list is read,
 * or for a connection no longer there.
 */
export function useConnectionLabels(): (connectionId: string) => string {
  const servers = useQuery(serversQuery).data
  return (connectionId) => servers?.find((server) => server.connectionId === connectionId)?.label ?? connectionId
}

/**
 * The Goblin Wallet the owner connected, as Pro's pages show it (ADR 0054): the dollar stablecoins its status says it
 * holds (`stablecoinUsd`, the server's claim) and its configured endpoint, whose origin has its Add funds page. Each is
 * absent until the wallet is connected and its status reads. An account without a plan reads it too: only chat needs
 * one.
 */
export function useGoblinWallet(): { readonly dollars: number | undefined; readonly endpoint: string | undefined } {
  const wallet = goblinWalletOf(useQuery(serversQuery).data)
  const status = useQuery(serverStatusQuery(wallet?.connectionId ?? '', wallet?.profile?.status === true)).data
  return { dollars: heldOf(status), endpoint: wallet?.endpoint }
}

/**
 * Signs a connection the owner already has in, from wherever they said yes: off to its sign-in, or connected at once
 * if it needs none.
 */
export function useConnectNow() {
  const connecting = useMutation(connectMutation).mutateAsync
  return async (connectionId: string): Promise<void> => {
    const { authorizationUrl } = await connecting({ connectionId })
    if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
  }
}

/** How a connection is added: the owner's label for it (a free one is chosen when left out) and where it was found. */
export type AddOptions = { readonly label?: string; readonly source?: ServerSource }

/**
 * Adds a server and starts connecting it, from wherever the owner said yes: off to its sign-in, or connected at once if
 * it needs none. The answer is what to tell the owner.
 */
export function useAddAndConnect() {
  const adding = useMutation(addAndConnectMutation).mutateAsync
  return async (endpoint: string, title: string, options: AddOptions = {}): Promise<string> => {
    const { label, source } = options
    const started = await adding({
      endpoint,
      ...(label === undefined ? {} : { label }),
      ...(source === undefined ? {} : { source }),
    })
    if (started.authorizationUrl !== undefined) window.location.assign(started.authorizationUrl)
    return `Connected ${label ?? title}. Choose the tools your agent may use.`
  }
}
