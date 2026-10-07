import type { TurnTimeline } from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'

const hasUnendedEvent = (turn: RunEvent, events: readonly RunEvent[]) =>
  events.some((event) => event.status === 'started' && event.id !== turn.id)
const hasAttempt = (events: readonly RunEvent[]) => events.some((event) => event.kind === 'model.attempt')
const hasAnswerEvent = (events: readonly RunEvent[], answer: number) =>
  events.some((event) => event.kind === 'model.attempt' && event.attributes[RunAttribute.entry] === answer)

/** What a timeline cannot show, said plainly (ADR 0024). */
export function coverageGaps(
  turn: RunEvent,
  events: readonly RunEvent[],
  submission?: TurnTimeline['submission'],
): string[] {
  const gaps: string[] = []
  if (turn.status === 'interrupted' || turn.attributes[RunAttribute.recovery] !== undefined)
    gaps.push('The agent restarted during this turn; work in flight then is marked interrupted.')
  if (hasUnendedEvent(turn, events))
    gaps.push('Some events have not ended: still running, or lost if the agent stopped.')
  if (turn.status === 'ok' && !hasAttempt(events)) gaps.push('No model attempts were recorded for this turn.')
  if (submission === undefined)
    gaps.push("Pi's submission settlement is not available; the run may have stopped before it was read.")
  else if (submission.status === 'done' && submission.answer === undefined)
    gaps.push('Pi settled the submission without recording a final answer.')
  if (submission?.answer !== undefined && !hasAnswerEvent(events, submission.answer))
    gaps.push("Pi's final answer is missing from the run timeline; later work may be uncorrelated.")
  if (turn.attributes[RunAttribute.coverageGap] === true) gaps.push('The settlement detected incomplete run coverage.')
  if (events.some((event) => event.kind === 'compaction'))
    gaps.push("A compaction ran; its summary's model call is not recorded.")
  return gaps
}
