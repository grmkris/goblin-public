import type { PersonaInvocationView } from '@goblin/contracts'
import { answering } from '../../lib/workspace-feed.ts'
import { PersonaAvatar } from '../persona-avatar.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

const byOrder = (a: PersonaInvocationView, b: PersonaInvocationView) => a.order - b.order || a.persona - b.persona

/**
 * The Personas still answering in a chat, one row each after its transcript, until each answer arrives in it: "answering…"
 * while one writes, "waiting…" while one waits its turn.
 */
export function Answering({ chat }: { readonly chat: string }) {
  const feed = useWorkspaceFeed()
  const pending = feed.invocations.filter((each) => each.chat === chat && answering(each)).toSorted(byOrder)
  if (pending.length === 0) return null
  const personas = new Map(feed.personas.map((persona) => [persona.id, persona]))
  return (
    <div className="answering" aria-live="polite">
      {pending.map((invocation) => {
        const persona = personas.get(invocation.persona)
        return (
          <p key={`${invocation.operationId}:${invocation.persona}`} className="answering-row">
            {persona !== undefined && <PersonaAvatar avatar={persona.avatar} size="sm" />}
            <b>{persona?.name ?? 'A persona'}</b>
            <span data-state={invocation.state}>{invocation.state === 'running' ? 'answering…' : 'waiting…'}</span>
          </p>
        )
      })}
    </div>
  )
}
