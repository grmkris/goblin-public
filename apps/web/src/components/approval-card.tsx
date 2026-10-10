import { useMutation, useQuery } from '@tanstack/react-query'
import { AskCard, AskCardHeader, AskCardDescription, AskCardActions, Button, JsonView, Receipt } from '@goblin/ui'
import { KeyRoundIcon } from 'lucide-react'
import { approvalQuery, decideApprovalMutation } from '../approvals/queries.ts'
import type { Interaction } from '../lib/interactions.ts'
import { messageOf } from '../lib/query/app-error.ts'

type Approval = Extract<Interaction, { kind: 'approval' }>

/**
 * The owner reviews the durable call, not arguments supplied by remote content or the browser. It is read while it
 * waits; what went wrong deciding it, or reading it, shows on the card.
 */
export function ApprovalCard({ interaction }: { readonly interaction: Approval }) {
  const read = useQuery(approvalQuery(interaction.approvalId))
  const decision = useMutation(decideApprovalMutation(interaction.approvalId))
  const view = read.data
  const busy = decision.isPending
  const error =
    decision.error !== null
      ? messageOf(decision.error, 'record your decision')
      : read.error !== null
        ? messageOf(read.error, 'read the call')
        : ''
  const decide = (allowed: boolean) => decision.mutate(allowed)
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
        <Button variant="ghost" disabled={busy || !pending} onClick={() => decide(false)}>
          Refuse
        </Button>
        <Button disabled={busy || !pending} onClick={() => decide(true)}>
          Approve once
        </Button>
      </AskCardActions>
    </AskCard>
  )
}
