import type { Operation } from '@goblin/wallet/contract'
import { useActivity } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { ReceiptRow } from '../ui/index.ts'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, RowList } from '../ui/page.tsx'

function Row({ operation }: { readonly operation: Operation }) {
  if (operation.status !== 'awaiting_approval') return <ReceiptRow operation={operation} />
  return (
    <Link
      to={`/approve/${operation.id}`}
      className="-mx-4 block rounded-lg px-4 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring active:bg-muted pointer-fine:hover:bg-muted"
    >
      <ReceiptRow operation={operation} />
    </Link>
  )
}

export function ActivityPage() {
  const activity = useActivity()
  return (
    <Page title="Activity" description="Everything your agent paid for or tried to, newest first, with the receipt.">
      <Async query={activity}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No activity yet" description="Connect an agent and ask it to buy something small." />
          ) : (
            <RowList>
              {rows.map((operation) => (
                <Row key={operation.id} operation={operation} />
              ))}
            </RowList>
          )
        }
      </Async>
    </Page>
  )
}
