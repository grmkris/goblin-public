import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { AppPower } from '@goblin/contracts'
import { AskCard, AskCardDescription, AskCardHeader, Button } from '@goblin/ui'
import { ShieldCheckIcon } from 'lucide-react'
import { failureText, request } from '../../lib/boundary.ts'

const decodePowers = Schema.decodeUnknownSync(Schema.Array(AppPower))

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
      return 'Ask a model (it counts toward your daily tokens)'
    case 'notify':
      return 'Message you on Telegram (at most 10 a day)'
  }
}

/**
 * What an agent app asks to do beyond its own state and files (ADR 0021), as its build shows it: each power it waits
 * for, read live, with Allow. Its powers fail until the owner allows them; nothing is allowed by the agent.
 */
export function AppPowers({ app, title }: { readonly app: string; readonly title: string }) {
  const [powers, setPowers] = useState<readonly AppPower[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = `/api/agent-apps/${encodeURIComponent(app)}/powers`
  useEffect(() => {
    let live = true
    request(path)
      .then((value) => {
        if (live) setPowers(decodePowers(value))
      })
      .catch((cause: unknown) => {
        if (live) setError(failureText(cause))
      })
    return () => {
      live = false
    }
  }, [path])
  const waiting = (powers ?? []).filter((power) => power.status !== 'approved')
  async function allow(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      let next = powers
      for (const power of waiting)
        next = decodePowers(
          await request(path, { method: 'PUT', body: { kind: power.kind, target: power.target, allowed: true } }),
        )
      setPowers(next)
    } catch (cause) {
      setError(failureText(cause))
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
