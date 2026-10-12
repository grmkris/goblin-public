import { Button } from '@goblin/ui'
import type { Operation, OperationCheck } from '@goblin/wallet/contract'
import { useActivity, useCheckOperation } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { ReceiptRow } from '../ui/index.ts'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, RowList } from '../ui/page.tsx'

function Row({
  operation,
  onCheck,
}: {
  readonly operation: Operation
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
}) {
  if (operation.status !== 'awaiting_approval') return <ReceiptRow operation={operation} onCheck={onCheck} />
  return (
    <ReceiptRow
      operation={operation}
      action={
        <Button size="sm" nativeButton={false} render={<Link to={`/approve/${operation.id}`} />}>
          Review
        </Button>
      }
    />
  )
}

export function ActivityPage() {
  const activity = useActivity()
  const check = useCheckOperation()
  return (
    <Page
      title="Activity"
      description="Everything your agent paid for or tried to, newest first. Open a row for its details."
    >
      <Async query={activity}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No activity yet" description="Connect an agent and ask it to buy something small." />
          ) : (
            <RowList>
              {rows.map((operation) => (
                <Row key={operation.id} operation={operation} onCheck={(each) => check.mutateAsync(each.id)} />
              ))}
            </RowList>
          )
        }
      </Async>
    </Page>
  )
}
