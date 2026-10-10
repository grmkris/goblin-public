import { useMutation } from '@tanstack/react-query'
import type { ServerSource } from '@goblin/contracts'
import { addAndConnectMutation } from './queries.ts'

/**
 * Adds a server and starts connecting it, from wherever the owner said yes: off to its sign-in, or connected at once if
 * it needs none. The answer is what to tell the owner.
 */
export function useAddAndConnect() {
  const adding = useMutation(addAndConnectMutation).mutateAsync
  return async (endpoint: string, title: string, source?: ServerSource): Promise<string> => {
    const started = await adding({ endpoint, ...(source === undefined ? {} : { source }) })
    if (started.authorizationUrl !== undefined) window.location.assign(started.authorizationUrl)
    return `Connected ${title}. Choose the tools your agent may use.`
  }
}
