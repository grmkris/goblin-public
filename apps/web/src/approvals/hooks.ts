import { useQueries } from '@tanstack/react-query'
import { NotFound } from '@goblin/contracts/api'
import { type Interaction, type StoredStates, followUrlRequests, storedId } from '../lib/interactions.ts'
import { approvalQuery, urlRequestQuery } from './queries.ts'

/**
 * Where each stored ask in `interactions` stands, from the reads its card keeps (a held call's, a URL request's):
 * `gone` once its store no longer has it, nothing while it has not been read.
 */
export function useStoredStates(interactions: readonly Interaction[]): StoredStates {
  const stored = interactions.flatMap((interaction) => {
    const id = storedId(interaction)
    return id === undefined ? [] : [{ interaction, id }]
  })
  return useQueries({
    queries: stored.map(({ interaction, id }) =>
      interaction.kind === 'url' ? urlRequestQuery(id) : approvalQuery(id),
    ),
    combine: (reads) =>
      new Map(
        reads.flatMap((read, index): [string, string][] => {
          const id = stored[index]?.id
          if (id === undefined) return []
          if (read.error instanceof NotFound) return [[id, 'gone']]
          return read.data === undefined ? [] : [[id, read.data.state]]
        }),
      ),
  })
}

/**
 * The interactions as they stand now: a held call whose approved dispatch met a URL request (ADR 0042) goes on as that
 * request (`followUrlRequests`), read from the approval its card keeps reading.
 */
export function useFollowed(interactions: readonly Interaction[]): readonly Interaction[] {
  return useQueries({
    queries: interactions.flatMap((interaction) =>
      interaction.kind === 'approval' ? [approvalQuery(interaction.approvalId)] : [],
    ),
    combine: (reads) =>
      followUrlRequests(
        interactions,
        new Map(
          reads.flatMap((read): [string, string][] =>
            read.data?.urlRequest === undefined ? [] : [[read.data.id, read.data.urlRequest]],
          ),
        ),
      ),
  })
}
