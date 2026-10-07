import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { ApprovalView } from '@goblin/contracts'
import { AskCard, AskCardHeader, AskCardDescription, AskCardActions, Button, JsonView, Receipt } from '@goblin/ui'
import { KeyRoundIcon } from 'lucide-react'
import type { Interaction } from '../lib/interactions.ts'
import { failureText, request } from '../lib/boundary.ts'

const decode = Schema.decodeUnknownSync(ApprovalView)
type Approval = Extract<Interaction, { kind: 'approval' }>

/** The owner reviews the durable call, not arguments supplied by remote content or the browser. */
export function ApprovalCard({ interaction }: { readonly interaction: Approval }) {
  const [view, setView] = useState<ApprovalView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = `/api/mcp/approvals/${encodeURIComponent(interaction.approvalId)}`
  const waiting = view === undefined || ['pending', 'approved', 'dispatching'].includes(view.state)
  useEffect(() => {
    if (!waiting) return undefined
    const controller = new AbortController()
    const load = () =>
      void request(path, { signal: controller.signal })
        .then((data) => setView(decode(data)))
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(failureText(cause))
        })
    load()
    const timer = setInterval(load, 5000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [path, waiting])
  async function decide(allowed: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setView(decode(await request(path, { method: 'POST', body: { allowed } })))
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setBusy(false)
    }
  }
  const pending = view?.state === 'pending'
  if (view?.state === 'completed' || view?.state === 'refused') return null
  return (
    <AskCard aria-label="Approve this call">
      <AskCardHeader>
        <KeyRoundIcon aria-hidden />
        <p>
          Approve{' '}
          <strong>
            {interaction.serverId} · {interaction.name}
          </strong>
          ?
        </p>
      </AskCardHeader>
      <AskCardDescription>
        These exact arguments will run once if you approve. Credential fields are hidden.
      </AskCardDescription>
      {view !== undefined && <JsonView value={view.arguments} />}
      {view !== undefined && !pending && (
        <Receipt tone={view.state === 'uncertain' || view.state === 'failed' ? 'error' : 'neutral'}>
          {view.state === 'uncertain'
            ? 'The response was interrupted. The call may have taken effect; check the service before trying again.'
            : `Call ${view.state}.`}
        </Receipt>
      )}
      {error && <Receipt tone="error">{error}</Receipt>}
      <AskCardActions>
        <Button variant="ghost" disabled={busy || !pending} onClick={() => void decide(false)}>
          Refuse
        </Button>
        <Button disabled={busy || !pending} onClick={() => void decide(true)}>
          Approve once
        </Button>
      </AskCardActions>
    </AskCard>
  )
}
