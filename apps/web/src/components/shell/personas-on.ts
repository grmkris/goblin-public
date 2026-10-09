import { useEffect, useState } from 'react'
import { PersonaView } from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { record, request } from '../../lib/boundary.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

const decodePersona = Schema.decodeUnknownOption(PersonaView)

/** The server's answer to `GET /api/personas`, asked once a page load: its Personas, or nothing where it has none. */
let listed: Promise<readonly PersonaView[] | undefined> | undefined
function listPersonas(): Promise<readonly PersonaView[] | undefined> {
  listed ??= request('/api/personas').then(
    (data) => {
      const items: unknown = Array.isArray(data) ? data : record(data)?.personas
      return Array.isArray(items) ? items.flatMap((item: unknown) => Option.toArray(decodePersona(item))) : undefined
    },
    () => undefined,
  )
  return listed
}

/**
 * Whether the server has Personas: its feed lists them, or (from one whose feed does not yet) its Personas route
 * answers; the Personas that answer then show as the feed's. Persona controls show only where this holds.
 */
export function usePersonasOn(): boolean {
  const feed = useWorkspaceFeed()
  const [answered, setAnswered] = useState(false)
  const listedByFeed = feed.personas !== undefined
  const { apply } = feed
  useEffect(() => {
    if (listedByFeed) return
    let current = true
    void listPersonas().then((personas) => {
      if (!current || personas === undefined) return
      setAnswered(true)
      apply(personas.map((persona) => ({ type: 'persona', persona })))
    })
    return () => {
      current = false
    }
  }, [listedByFeed, apply])
  return listedByFeed || answered
}
