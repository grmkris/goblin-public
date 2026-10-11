// What a Persona's answer waits on (ADR 0041): a held call to approve, or a tool to allow. Drawn under the Persona's
// newest answer only, from its `app.persona` entry, never from a tool result; the owner's reply goes to its fork.
import type { PersonaHold } from '@goblin/contracts'
import { useMutation } from '@tanstack/react-query'
import { replyPersonaMutation } from '../../personas/queries.ts'
import { ApprovalCard } from '../approval-card.tsx'
import { GrantCard } from '../interaction-cards.tsx'

/**
 * A Persona's hold, as a card under its answer: an approval decides the held call (the Persona then goes on with the
 * outcome), a grant allows the tool and replies to the Persona's fork so it goes on.
 */
export function PersonaHoldCard({
  hold,
  answer,
  name,
}: {
  readonly hold: PersonaHold
  readonly answer: string
  readonly name: string
}) {
  const reply = useMutation(replyPersonaMutation)
  const { connectionId, fork } = hold
  if (hold.kind === 'approval')
    return hold.approvalId === undefined ? null : (
      <ApprovalCard
        interaction={{ kind: 'approval', callId: answer, approvalId: hold.approvalId, connectionId, name: hold.name }}
      />
    )
  return (
    <GrantCard
      interaction={{ kind: 'grant', callId: answer, connectionId, name: hold.name }}
      who={`@${name}`}
      onAnswer={async (text, operationId) => {
        await reply.mutateAsync({ fork, operationId, text })
        return true
      }}
    />
  )
}
