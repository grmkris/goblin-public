import type { EphemeralMessage } from '@goblin/contracts'
import { entryOfPart } from './threads.ts'

/** A part of a transcript, as far as placing an owner-only message goes: its id starts with its entry. */
type Placed = { readonly id: string }

/**
 * Where each owner-only message shows in a chat (`EphemeralMessage`): after the last part of the entry it follows, or at
 * the end when it names none or that entry is not shown. Messages keep their order of creation.
 */
export function ephemeralPlaces(
  parts: readonly Placed[],
  messages: readonly EphemeralMessage[],
): { readonly after: ReadonlyMap<string, readonly EphemeralMessage[]>; readonly end: readonly EphemeralMessage[] } {
  const lastOf = new Map<number, string>()
  for (const part of parts) {
    const entry = entryOfPart(part.id)
    if (entry !== undefined) lastOf.set(entry, part.id)
  }
  const after = new Map<string, EphemeralMessage[]>()
  const end: EphemeralMessage[] = []
  for (const message of messages.toSorted((a, b) => a.createdAt - b.createdAt)) {
    const part = message.afterEntry === undefined ? undefined : lastOf.get(message.afterEntry)
    if (part === undefined) end.push(message)
    else after.set(part, [...(after.get(part) ?? []), message])
  }
  return { after, end }
}
