import { Button } from '@goblin/ui'
import type { Operation } from '@goblin/wallet/contract'
import { useActivity, useCheckOperation, useSubscriptionPayments } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { ActivityRow } from '../ui/activity-row.tsx'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, RowList } from '../ui/page.tsx'
import { type FeedRow, feedOf, groupByDay, rowTime } from './activity-model.ts'
import { PaymentRow } from './payment-row.tsx'

/** An approval keeps its way to the approval page in view; everything else opens in place. */
export const reviewOf = (operation: Operation) =>
  operation.status === 'awaiting_approval'
    ? {
        action: (
          <Button size="sm" nativeButton={false} render={<Link to={`/approve/${operation.id}`} />}>
            Review
          </Button>
        ),
      }
    : {}

/**
 * Everything the agent paid for or tried to, and what the owner's subscriptions paid, by day, newest first. An
 * operation opens to its details; a payment to its transaction.
 */
export function ActivityPage() {
  const activity = useActivity()
  const payments = useSubscriptionPayments()
  const check = useCheckOperation()
  const row = (each: FeedRow) =>
    each.kind === 'payment' ? (
      <PaymentRow key={each.key} payment={each.payment} time={rowTime(each.at)} />
    ) : (
      <ActivityRow
        key={each.key}
        operation={each.operation}
        time={rowTime(each.at)}
        onCheck={(operation) => check.mutateAsync(operation.id)}
        {...reviewOf(each.operation)}
      />
    )
  return (
    <Page title="Activity">
      <Async query={activity}>
        {(operations) => {
          const rows = feedOf(operations, payments.data)
          return rows.length === 0 ? (
            <EmptyState title="Nothing spent yet" description="When your agent pays for something, it shows up here." />
          ) : (
            <div className="flex flex-col gap-6">
              {groupByDay(rows).map((group) => (
                <section key={group.key} aria-labelledby={`day-${group.key}`} className="flex flex-col gap-2">
                  <h2 id={`day-${group.key}`} className="ps-1 text-13 font-medium text-muted-foreground">
                    {group.label}
                  </h2>
                  <RowList className="overflow-clip">{group.rows.map(row)}</RowList>
                </section>
              ))}
            </div>
          )
        }}
      </Async>
    </Page>
  )
}
