import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Option, Schema } from 'effect'
import type { RoutineView } from '@goblin/contracts'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { record } from '../../lib/values.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { reviewedRoutinesQuery } from '../../routines/queries.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { RoutineReview } from '../routines.tsx'
import { ToolCard } from './tool-part.tsx'

const Receipt = Schema.Struct({
  kind: Schema.Literal('routine-proposal'),
  routineId: Schema.String,
  revision: Schema.Int,
})
const decodeReceipt = Schema.decodeUnknownOption(Receipt)
/** What the review shows: the routine as it is now, or why there is none to review. */
export function reviewed(routines: readonly RoutineView[] | undefined, routineId: string, revision: number) {
  if (routines === undefined) return { routine: undefined, note: '' }
  const routine = routines.find((item) => item.id === routineId)
  if (routine === undefined) return { routine, note: 'This routine has been archived or removed.' }
  const note = routine.revision === revision ? '' : 'The routine has changed. Review its current revision below.'
  return { routine, note }
}

/** Load the current owner-visible definition; tool text never activates or supplies the review authority. */
export function RoutineProposalPart({ part }: { readonly part: ToolPart }) {
  const details = record(part.result?.details)
  const receipt = Option.getOrUndefined(decodeReceipt(details))
  const [open, setOpen] = useState(false)
  const read = useQuery(reviewedRoutinesQuery(open))
  // The review shows the routines as read after it opened, never a list cached before it.
  const { routine, note } = reviewed(
    read.isFetchedAfterMount ? read.data?.routines : undefined,
    receipt?.routineId ?? '',
    receipt?.revision ?? 0,
  )
  const error = read.error === null ? note : messageOf(read.error, 'read the routine')
  return (
    <ToolCard part={part}>
      {receipt && details && !('origin' in details) && !part.result?.isError && (
        <Button
          size="sm"
          variant="outline"
          pending={open && read.isFetching}
          onClick={() => (open ? void read.refetch() : setOpen(true))}
        >
          Review routine proposal
        </Button>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {routine && <RoutineReview routine={routine} />}
    </ToolCard>
  )
}
