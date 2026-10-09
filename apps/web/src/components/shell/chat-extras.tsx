import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type RetrievalSource, SourceUse } from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { request } from '../../lib/boundary.ts'
import { ephemeralPlaces } from '../../lib/ephemeral.ts'
import { missing } from '../../lib/features.ts'
import type { Part } from '../../lib/parts.ts'
import { sourcePlaces } from '../../lib/sources.ts'
import { SourcesStrip } from '../parts/sources-strip.tsx'
import { Answering } from './answering.tsx'
import { EphemeralRow, useEphemeral } from './ephemeral-slot.tsx'

const decodeUse = Schema.decodeUnknownOption(SourceUse)
/** Set once the server answered that it keeps no sources, so no chat asks again until the page reloads. */
let sourcesMissing = false

/**
 * What automatic retrieval gave each owner input of a chat (`GET …/sources`): read when the chat opens and again each
 * time a run ends. A server without the route has none.
 */
function useSourceUses(chat: string, running: boolean): readonly SourceUse[] {
  const [uses, setUses] = useState<readonly SourceUse[]>([])
  const was = useRef(running)
  const ended = was.current && !running
  was.current = running
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (ended) setRound((count) => count + 1)
  }, [ended])
  useEffect(() => {
    if (sourcesMissing) return
    const controller = new AbortController()
    request(`/api/conversations/${chat}/sources`, { signal: controller.signal })
      .then((data) => {
        const items: unknown[] = Array.isArray(data) ? data : []
        setUses(items.flatMap((item) => Option.toArray(decodeUse(item))))
      })
      .catch((failure: unknown) => {
        if (missing(failure)) sourcesMissing = true
      })
    return () => controller.abort()
  }, [chat, round])
  return uses
}

const flat = (uses: readonly SourceUse[]): RetrievalSource[] => uses.flatMap((use) => use.sources)

/**
 * What a chat's transcript shows beside its own messages: under an answer the sources automatic retrieval gave it,
 * the owner-only messages where they belong, and after everything the Personas still answering.
 */
export function useChatExtras(chat: string, parts: readonly Part[], running: boolean) {
  const uses = useSourceUses(chat, running)
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
