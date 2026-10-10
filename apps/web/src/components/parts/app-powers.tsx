import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { AppPower } from '@goblin/contracts'
import { AskCard, AskCardDescription, AskCardHeader, Button } from '@goblin/ui'
import { ShieldCheckIcon } from 'lucide-react'
import { agentAppQuery, changeAgentAppMutation } from '../../agent-apps/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'

/** A power in the owner's words. */
export function powerText(power: Pick<AppPower, 'kind' | 'target'>): string {
  const [server = '', tool = ''] = power.target.split('/', 2)
  switch (power.kind) {
    case 'egress':
      return `Fetch from ${power.target}`
    case 'tool':
      return `Use your tool ${server} · ${tool}`
    case 'app':
      return `Use your app ${power.target}`
    case 'llm':
      return 'Ask a model (it counts toward your daily Credits)'
    case 'notify':
      return 'Message you on Telegram (at most 10 a day)'
  }
}

/**
 * What an agent app asks to do beyond its own state and files (ADR 0021), as its build shows it: each power it waits
 * for, read live, with Allow. Its powers fail until the owner allows them; nothing is allowed by the agent.
 */
export function AppPowers({ app, title }: { readonly app: string; readonly title: string }) {
  const detail = useQuery(agentAppQuery(app))
  const change = useMutation(changeAgentAppMutation(app)).mutateAsync
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  const powers = detail.data?.powers
  const error = refused !== '' || detail.error === null ? refused : messageOf(detail.error, 'read what it asks')
  const waiting = (powers ?? []).filter((power) => power.status !== 'approved')
  /** Allows each waiting power in turn; each answer is the app as it now is, so the card follows it. */
  async function allow(): Promise<void> {
    setBusy(true)
    setRefused('')
    try {
      for (const power of waiting)
        await change({ kind: 'power', power: power.kind, target: power.target, allowed: true })
    } catch (cause) {
      setRefused(messageOf(cause, 'allow it'))
    } finally {
      setBusy(false)
    }
  }
  if (powers === undefined && error === '') return null
  if (powers !== undefined && waiting.length === 0) return null
  return (
    <AskCard aria-label={`What ${title} asks to do`}>
      <AskCardHeader>
        <ShieldCheckIcon aria-hidden />
        <p>
          <strong className="font-medium">{title}</strong> asks to:
        </p>
      </AskCardHeader>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {waiting.map((power) => (
          <li key={`${power.kind} ${power.target}`}>{powerText(power)}</li>
        ))}
      </ul>
      <AskCardDescription>
        Until you allow them, these fail and the app keeps working without them. Your agent cannot allow them.
      </AskCardDescription>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" disabled={busy || waiting.length === 0} onClick={() => void allow()}>
          Allow
        </Button>
      </div>
    </AskCard>
  )
}
