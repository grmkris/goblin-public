import { useState } from 'react'
import { Option, Schema } from 'effect'
import { RoutinePage, type RoutineView } from '@purrable/contracts'
import { Alert, AlertDescription, Button } from '@purrable/ui'
import { failureText, record, request } from '../../lib/boundary.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { RoutineReview } from '../routines.tsx'
import { ToolCard } from './tool-part.tsx'

const Receipt = Schema.Struct({
  kind: Schema.Literal('routine-proposal'),
  routineId: Schema.String,
  revision: Schema.Int,
})
const decodeReceipt = Schema.decodeUnknownOption(Receipt)
/** Load the current owner-visible definition; tool text never activates or supplies the review authority. */
export function RoutineProposalPart({ part }: { readonly part: ToolPart }) {
  const details = record(part.result?.details)
  const receipt = Option.getOrUndefined(decodeReceipt(details))
  const [routine, setRoutine] = useState<RoutineView>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function review() {
    if (!receipt) return
    setPending(true)
    try {
      const page = Schema.decodeUnknownSync(RoutinePage)(await request('/api/routines'))
      const current = page.routines.find((item) => item.id === receipt.routineId)
      if (!current) {
        setError('This routine has been archived or removed.')
        return
      }
      setRoutine(current)
      if (current.revision !== receipt.revision) setError('The routine has changed. Review its current revision below.')
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <ToolCard part={part}>
      {receipt && details && !('origin' in details) && !part.result?.isError && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void review()}>
          Review routine proposal
        </Button>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {routine && <RoutineReview routine={routine} onChange={setRoutine} />}
    </ToolCard>
  )
}
