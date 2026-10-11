// What a Persona's answer waits on (ADRs 0041, 0042): a held call to approve, a tool to allow, a sign-in with more
// access, or a URL request to finish. Drawn under the Persona's newest answer only, from its `app.persona` entry, never
// from a tool result; the owner's reply goes to its fork.
import type { PersonaHold } from '@goblin/contracts'
import { useMutation } from '@tanstack/react-query'
import { replyPersonaMutation } from '../../personas/queries.ts'
import { ApprovalCard } from '../approval-card.tsx'
import { AccessCard, GrantCard } from '../interaction-cards.tsx'

/**
 * A Persona's hold, as a card under its answer: an approval decides the held call (the Persona then goes on with the
 * outcome); a grant allows the tool, and a sign-in with more access opens the server's consent, each replying to the
 * Persona's fork so it goes on.
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
  const onAnswer = async (text: string, operationId: string) => {
    await reply.mutateAsync({ fork, operationId, text })
    return true
  }
  if (hold.kind === 'approval')
    return hold.approvalId === undefined ? null : (
      <ApprovalCard
        interaction={{ kind: 'approval', callId: answer, approvalId: hold.approvalId, connectionId, name: hold.name }}
      />
    )
  if (hold.kind === 'access')
    return (
      <AccessCard
        interaction={{ kind: 'access', callId: answer, connectionId, scope: hold.scope ?? '' }}
        onAnswer={onAnswer}
      />
    )
  // A URL request's card comes with the URL request card itself.
  if (hold.kind === 'url') return null
  return (
    <GrantCard
      interaction={{ kind: 'grant', callId: answer, connectionId, name: hold.name }}
      who={`@${name}`}
      onAnswer={onAnswer}
    />
  )
}
