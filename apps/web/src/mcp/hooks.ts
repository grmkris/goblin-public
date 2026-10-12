import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerSource } from '@goblin/contracts'
import { addAndConnectMutation, connectMutation, serversQuery } from './queries.ts'

/**
 * The owner's label of a connection by its id (ADR 0041), for anything that names one: the id until the list is read,
 * or for a connection no longer there.
 */
export function useConnectionLabels(): (connectionId: string) => string {
  const servers = useQuery(serversQuery).data
  return (connectionId) => servers?.find((server) => server.connectionId === connectionId)?.label ?? connectionId
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
