// The agent wallet is made for the owner, not by a button: the first time setup or consent sees an owner without one,
// it asks the Worker's idempotent `POST /api/onboarding/agent` once, and shows that moment for long enough to read.
import { Button, Spinner } from '@goblin/ui'
import type { Me } from '@goblin/wallet/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useApi } from '../../api/queries.tsx'
import { errorText } from '../../ui/async.tsx'
import { ActionError } from '../setup-actions.tsx'

/** How long "Creating your agent wallet…" stays at least, so a quick answer does not flash past. */
const MOMENT_MS = 1200

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface AgentWallet {
  readonly creating: boolean
  readonly error: string | undefined
  readonly retry: () => void
}

/** Creates the owner's agent wallet once when they have none; the owner wallet (Privy's index 0) is never touched. */
export function useAgentWallet(me: Me | undefined): AgentWallet {
  const api = useApi()
  const client = useQueryClient()
  const create = useMutation({
    mutationFn: async () => {
      const [created] = await Promise.all([api.createAgent(), pause(MOMENT_MS)])
      return created
    },
    onSuccess: (created) => client.setQueryData(['me'], created),
  })
  const missing = me !== undefined && me.agent === undefined
  const asked = useRef(false)
  const { mutate } = create
  useEffect(() => {
    if (!missing || asked.current) return
    asked.current = true
    mutate()
  }, [missing, mutate])
  return {
    creating: missing && !create.isError,
    error: create.isError ? errorText(create.error) : undefined,
    retry: () => mutate(),
  }
}

/** The moment between signing in and adding funds: the agent wallet being made, or why it was not. */
export function AgentScreen({ agent }: { readonly agent: AgentWallet }) {
  return (
    <section aria-live="polite" className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
      {agent.error === undefined ? (
        <>
          <span className="text-muted-foreground">
            <Spinner className="size-6" />
          </span>
          <h2 className="text-xl font-semibold tracking-tight">Creating your agent wallet…</h2>
          <p className="max-w-72 text-sm/relaxed text-muted-foreground text-pretty">
            Your agent gets its own address. It can only spend within the limits you set.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold tracking-tight">Your agent wallet was not created</h2>
          <ActionError message={agent.error} />
          <Button type="button" size="cta" onClick={agent.retry}>
            Try again
          </Button>
        </>
      )}
    </section>
  )
}
