// What a receipt says, derived from an operation: payment and delivery are separate answers, and the model gets a
// short bounded line, never the paid content.
import type { Operation, OperationStatus } from '@goblin/wallet/contract'
import { formatUsd, statusLabel } from '../ui/index.ts'

export type Step = {
  readonly label: string
  readonly detail: string | undefined
  readonly tone: 'ok' | 'wait' | 'bad' | 'quiet'
}

const PAYMENT: Record<OperationStatus, Step['tone']> = {
  quoted: 'quiet',
  awaiting_approval: 'wait',
  reserved: 'wait',
  signing: 'wait',
  submitted: 'wait',
  confirmed: 'ok',
  delivered: 'ok',
  failed: 'bad',
  uncertain: 'wait',
  expired: 'quiet',
  declined: 'quiet',
  cancelled: 'quiet',
}

const PAYMENT_LABEL: Record<OperationStatus, string> = {
  quoted: 'Not paid yet',
  awaiting_approval: 'Waiting for your approval',
  reserved: 'Reserved',
  signing: 'Signing',
  submitted: 'Sent, waiting for the chain',
  confirmed: 'Paid',
  delivered: 'Paid',
  failed: 'Not paid',
  uncertain: 'Outcome unknown',
  expired: 'Not paid',
  declined: 'Not paid',
  cancelled: 'Not paid',
}

/** Whether money may have left: a payment that settled, or one whose outcome is unknown. */
export const mayHavePaid = (status: OperationStatus): boolean =>
  status === 'confirmed' || status === 'delivered' || status === 'uncertain'

export function paymentStep(operation: Operation): Step {
  const { status } = operation
  const detail =
    status === 'uncertain'
      ? 'Kept reserved and never retried on its own. Check the transaction before paying again.'
      : status === 'failed'
        ? operation.reason
        : undefined
  return { label: PAYMENT_LABEL[status], detail, tone: PAYMENT[status] }
}

/** Delivery only exists for a request that was paid for: until then there is nothing to deliver. */
export function deliveryStep(operation: Operation): Step | undefined {
  if (operation.terms.kind !== 'paid_fetch') return undefined
  const { status, delivery } = operation
  if (status === 'delivered') return { label: delivery?.status ?? 'Delivered', detail: delivery?.detail, tone: 'ok' }
  if (status === 'confirmed') {
    if (delivery === undefined) return { label: 'Waiting for the service', detail: undefined, tone: 'wait' }
    return { label: `Failed: ${delivery.status}`, detail: delivery.detail, tone: 'bad' }
  }
  if (status === 'uncertain') return { label: 'Not known', detail: undefined, tone: 'quiet' }
  return undefined
}

/** One bounded line for the model: what was asked, what it cost, how it ended. Never a response body. */
export function modelSummary(operation: Operation): string {
  const { terms, status } = operation
  const delivery = deliveryStep(operation)
  const parts = [
    `Wallet receipt for ${terms.subject.slice(0, 80)}: ${formatUsd(terms.amountUsd)} on ${terms.chain} via ${terms.rail}`,
    `status ${statusLabel(status)} (${status})`,
    `payment: ${paymentStep(operation).label}`,
    delivery === undefined ? undefined : `delivery: ${delivery.label}`,
    `operation ${operation.id}`,
  ]
  return `${parts.filter((part) => part !== undefined).join('; ')}.`.slice(0, 500)
}
