import { Button } from '@goblin/ui'
import type { Operation } from '@goblin/wallet/contract'
import { useActivity, useCheckOperation } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { ActivityRow } from '../ui/activity-row.tsx'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, RowList } from '../ui/page.tsx'
import { groupByDay, rowTime } from './activity-model.ts'

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

/** Everything the agent paid for or tried to, by day, newest first. A row opens to its details. */
export function ActivityPage() {
  const activity = useActivity()
  const check = useCheckOperation()
  return (
    <Page title="Activity">
      <Async query={activity}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="Nothing spent yet" description="When your agent pays for something, it shows up here." />
          ) : (
            <div className="flex flex-col gap-6">
              {groupByDay(rows).map((group) => (
                <section key={group.key} aria-labelledby={`day-${group.key}`} className="flex flex-col gap-2">
                  <h2 id={`day-${group.key}`} className="ps-1 text-13 font-medium text-muted-foreground">
                    {group.label}
                  </h2>
                  <RowList className="overflow-clip">
                    {group.operations.map((operation) => (
                      <ActivityRow
                        key={operation.id}
                        operation={operation}
                        time={rowTime(operation.createdAt)}
                        onCheck={(each) => check.mutateAsync(each.id)}
                        {...reviewOf(operation)}
                      />
                    ))}
                  </RowList>
                </section>
              ))}
            </div>
          )
        }
      </Async>
    </Page>
  )
}
