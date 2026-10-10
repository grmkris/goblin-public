import { type ReactNode, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RetrievalSource, SourceUse } from '@goblin/contracts'
import { sourcesQuery } from '../../conversations/queries.ts'
import { ephemeralPlaces } from '../../lib/ephemeral.ts'
import type { Part } from '../../lib/parts.ts'
import { sourcePlaces } from '../../lib/sources.ts'
import { SourcesStrip } from '../parts/sources-strip.tsx'
import { Answering } from './answering.tsx'
import { EphemeralRow, useEphemeral } from './ephemeral-slot.tsx'

const NONE: readonly SourceUse[] = []

/**
 * What retrieval gave a chat's answers (`GET …/sources`, ADR 0035): read when the chat opens and again each time a run
 * there ends, which the workspace feed says (`lib/workspace/invalidations.ts`). Sources are a note under answers: a
 * read that fails keeps what was shown, and the next run's end reads again.
 */
const useSourceUses = (chat: string): readonly SourceUse[] => useQuery(sourcesQuery(chat)).data ?? NONE

const flat = (uses: readonly SourceUse[]): RetrievalSource[] => uses.flatMap((use) => use.sources)

/**
 * What a chat's transcript shows beside its own messages: under an answer the sources automatic retrieval gave it,
 * the owner-only messages where they belong, and after everything the Personas still answering.
 */
export function useChatExtras(chat: string, parts: readonly Part[]) {
  const uses = useSourceUses(chat)
  const ephemeral = useEphemeral(chat)
  const strips = useMemo(() => sourcePlaces(parts, uses), [parts, uses])
  const placed = useMemo(() => ephemeralPlaces(parts, ephemeral.messages), [parts, ephemeral.messages])
  const row = (message: (typeof ephemeral.messages)[number]) => (
    <EphemeralRow
      key={message.id}
      message={message}
      onAction={(action) => ephemeral.act(message, action)}
      onDismiss={() => ephemeral.dismiss(message)}
    />
  )
  const after = (part: Part): ReactNode => {
    const used = strips.get(part.id)
    const owner = placed.after.get(part.id)
    if (used === undefined && owner === undefined) return null
    return (
      <>
        {used !== undefined && <SourcesStrip sources={flat(used)} />}
        {owner?.map(row)}
      </>
    )
  }
  const trail = (
    <>
      {placed.end.map(row)}
      <Answering chat={chat} />
    </>
  )
  return { after, trail }
}
