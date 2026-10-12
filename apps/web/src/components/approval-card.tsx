import { useMutation, useQuery } from '@tanstack/react-query'
import { AskCard, AskCardHeader, AskCardDescription, AskCardActions, Button, JsonView, Receipt } from '@goblin/ui'
import type { ApprovalDecision, ApprovalView } from '@goblin/contracts'
import { CircleAlertIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react'
import { approvalQuery, decideApprovalMutation } from '../approvals/queries.ts'
import type { Interaction } from '../lib/interactions.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { serversQuery } from '../mcp/queries.ts'
import { PaidJob, RunUpTo, paidAmount } from './paid-job.tsx'

type Approval = Extract<Interaction, { kind: 'approval' }>

/** Where a held call stands once the owner decided, in words, until it leaves the dock. */
const STANDING: Partial<Record<ApprovalView['state'], { readonly text: string; readonly error: boolean }>> = {
  approved: { text: 'Approved. Sending the call…', error: false },
  dispatching: { text: 'Sending the call…', error: false },
  expired: { text: 'This request ran out of time before you decided. Nothing ran.', error: true },
  failed: { text: 'The call was not sent. Nothing ran.', error: true },
  uncertain: {
    text: 'The answer was cut off. The call may have run: check on the server before trying again.',
    error: true,
  },
}

/** Where the call stands after the owner's decision: on its way, or what went wrong. */
function Standing({ text, error }: { readonly text: string; readonly error: boolean }) {
  return (
    <Receipt tone={error ? 'error' : 'neutral'}>
      {error ? (
        <CircleAlertIcon aria-hidden />
      ) : (
        <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />
      )}
      <span>{text}</span>
    </Receipt>
  )
}

/** What the held call is: a paid job of a first-class server's paid tool (ADR 0044), or any other exact call. */
function usePaid(interaction: Approval) {
  const servers = useQuery(serversQuery).data
  const profile = servers?.find((server) => server.connectionId === interaction.connectionId)?.profile
  return profile?.spend?.tool === interaction.name ? profile : undefined
}

/** The decision under way, for the button that sent it. */
const sentBy = (decision: ApprovalDecision | undefined): 'refuse' | 'once' | 'rule' | undefined => {
  if (decision === undefined) return undefined
  if (!decision.allowed) return 'refuse'
  return decision.runUpTo === undefined ? 'once' : 'rule'
}

/** Who asks for what: approve an exact call, or a paid job of `call`. */
function ApprovalHeader({ paid, call }: { readonly paid: boolean; readonly call: string }) {
  return (
    <AskCardHeader>
      <KeyRoundIcon aria-hidden />
      {paid ? (
        <p>
          <strong className="font-medium">{call}</strong> wants to run a paid job
        </p>
      ) : (
        <p>
          Approve <strong>{call}</strong>?
        </p>
      )}
    </AskCardHeader>
  )
}

/**
 * Refuse, Approve once, and for a paid job (`paid`: its price, or undefined without one) Approve and run jobs up to an
 * amount without asking; `false` for any other call.
 */
function ApprovalActions({
  connectionId,
  paid,
  disabled,
  sending,
  onDecide,
}: {
  readonly connectionId: string
  readonly paid: string | undefined | false
  readonly disabled: boolean
  readonly sending: 'refuse' | 'once' | 'rule' | undefined
  readonly onDecide: (decision: ApprovalDecision) => void
}) {
  return (
    <AskCardActions>
      <Button
        variant="ghost"
        disabled={disabled}
        pending={sending === 'refuse'}
        onClick={() => onDecide({ allowed: false })}
      >
        Refuse
      </Button>
      <Button
        variant={paid === false ? 'default' : 'outline'}
        disabled={disabled}
        pending={sending === 'once'}
        onClick={() => onDecide({ allowed: true })}
      >
        Approve once
      </Button>
      {paid !== false && (
        <RunUpTo
          connectionId={connectionId}
          amount={paid}
          disabled={disabled}
          pending={sending === 'rule'}
          onApprove={(runUpTo) => onDecide({ allowed: true, runUpTo })}
        />
      )}
    </AskCardActions>
  )
}

/**
 * The owner reviews the durable call, not arguments supplied by remote content or the browser. It is read while it
 * waits; what went wrong deciding it, or reading it, shows on the card. A paid job (ADR 0044) shows what it costs,
 * where it goes and what the wallet has left, and can raise the spending rule as it is approved.
 */
export function ApprovalCard({ interaction }: { readonly interaction: Approval }) {
  const read = useQuery(approvalQuery(interaction.approvalId))
  const connection = useConnectionLabels()(interaction.connectionId)
  const decision = useMutation(decideApprovalMutation(interaction.approvalId))
  const paid = usePaid(interaction)
  const view = read.data
  const busy = decision.isPending
  const error =
    decision.error !== null
      ? messageOf(decision.error, 'record your decision')
      : read.error !== null
        ? messageOf(read.error, 'read the call')
        : ''
  const pending = view?.state === 'pending'
  if (view?.state === 'completed' || view?.state === 'refused') return null
  const standing = view === undefined ? undefined : STANDING[view.state]
  return (
    <AskCard aria-label={paid === undefined ? 'Approve this call' : 'Approve a paid job'}>
      <ApprovalHeader paid={paid !== undefined} call={`${connection} · ${interaction.name}`} />
      {paid !== undefined && view !== undefined && (
        <PaidJob connectionId={interaction.connectionId} profile={paid} args={view.arguments} />
      )}
      <AskCardDescription>
        These exact arguments will run once if you approve. Credential fields are hidden.
      </AskCardDescription>
      {view !== undefined && <JsonView value={view.arguments} />}
      {standing !== undefined && <Standing {...standing} />}
      {error && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{error}</span>
        </Receipt>
      )}
      <ApprovalActions
        connectionId={interaction.connectionId}
        paid={paid !== undefined && view !== undefined ? paidAmount(paid, view.arguments) : false}
        disabled={busy || !pending}
        sending={busy ? sentBy(decision.variables) : undefined}
        onDecide={(made) => decision.mutate(made)}
      />
    </AskCard>
  )
}
