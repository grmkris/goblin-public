import type { DecisionLabel } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { describeError, messageOf } from '../lib/query/app-error.ts'
import { applyWorkspaceChanges, setFeedStatus, workspaceQueries } from '../lib/workspace/sync.ts'

/** Typed decisions on the owner API (ADR 0031). The workspace feed carries the proposals (`useProposals`). */
export const decisionKeys = {
  all: ['decisions'] as const,
  label: ['decisions', 'label'] as const,
}

/** The owner's label of proposal `id`. */
export type LabelDecision = { readonly id: string; readonly label: DecisionLabel['label'] }

/**
 * The owner confirms or dismisses proposal `id`: its row goes at once (the proposal shows as the label settles it), and
 * the server's answer replaces it. A proposal that is gone, settled the other way or stale (404, 409) is not the
 * owner's to act on any more, so it stays gone and the feed shows what became of it; any other refusal brings the row
 * back and says why in the feed's status.
 */
export const labelDecisionMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { id, label }: LabelDecision) => api.decisions.label({ params: { id }, payload: { label } }),
  }),
  mutationKey: decisionKeys.label,
  onMutate: ({ id, label }, { client }) => {
    const shown = client.getQueryData(workspaceQueries.proposals.queryKey)?.find((proposal) => proposal.id === id)
    if (shown === undefined) return undefined
    const state = label === 'confirm' ? 'confirmed' : 'dismissed'
    applyWorkspaceChanges(client, [{ type: 'proposal', proposal: { ...shown, state } }])
    return shown
  },
  onError: (failure, _label, shown, { client }) => {
    const { kind } = describeError(failure)
    if (kind === 'not_found' || kind === 'conflict') return
    if (shown !== undefined) applyWorkspaceChanges(client, [{ type: 'proposal', proposal: shown }])
    setFeedStatus(client, messageOf(failure, 'keep your choice'))
  },
  onSuccess: (proposal, _label, _shown, { client }) => applyWorkspaceChanges(client, [{ type: 'proposal', proposal }]),
})
