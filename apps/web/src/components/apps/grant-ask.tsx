// When an App calls a tool the owner has not granted, its call waits on a card the host draws in the App's chrome,
// naming the exact tool. Allow grants that tool and retries; "Not now", or two minutes without an answer, fails the
// call as denied. The App's own words never reach this card; only the tool name it called does.
import { useCallback, useRef, useState } from 'react'
import { KeyRoundIcon } from 'lucide-react'
import { Button } from '@goblin/ui'
import { ApiFailure, failureText, request } from '../../lib/boundary.ts'

const WAIT_MS = 120_000

type Pending = { readonly name: string; readonly settle: (allowed: boolean) => void }

/** The owner's answer for one tool, asked once however many calls wait on it. */
export function useAppGrantAsks(serverId: string, onOpen?: () => void) {
  const [asks, setAsks] = useState<readonly string[]>([])
  const waiting = useRef(new Map<string, Promise<boolean>>())
  const settlers = useRef(new Map<string, Pending['settle']>())
  const ask = useCallback((name: string): Promise<boolean> => {
    const existing = waiting.current.get(name)
    if (existing) return existing
    const answer = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), WAIT_MS)
      function settle(allowed: boolean): void {
        clearTimeout(timer)
        waiting.current.delete(name)
        settlers.current.delete(name)
        setAsks((current) => current.filter((item) => item !== name))
        resolve(allowed)
      }
      settlers.current.set(name, settle)
    })
    waiting.current.set(name, answer)
    setAsks((current) => [...current, name])
    return answer
  }, [])
  const answer = useCallback((name: string, allowed: boolean) => settlers.current.get(name)?.(allowed), [])
  const [first] = asks
  const card =
    first === undefined ? null : (
      <AppGrantCard
        serverId={serverId}
        name={first}
        {...(onOpen === undefined ? {} : { onOpen })}
        onAnswer={(allowed) => answer(first, allowed)}
      />
    )
  return { ask, card }
}

/** True when an App's tool call failed only because the owner has not granted that tool. */
export function grantDenied(cause: unknown): boolean {
  return cause instanceof ApiFailure && cause.tag === 'GrantDenied'
}

function AppGrantCard({
  serverId,
  name,
  onAnswer,
  onOpen,
}: {
  readonly serverId: string
  readonly name: string
  readonly onOpen?: () => void
  readonly onAnswer: (allowed: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function allow(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await request('/api/mcp/grants', { method: 'PUT', body: { serverId, name, allowed: true } })
      onAnswer(true)
    } catch (cause) {
      setError(failureText(cause))
      setBusy(false)
    }
  }
  return (
    <div className="app-offer app-grant" role="alertdialog" aria-label="Permission request from the app">
      <KeyRoundIcon aria-hidden />
      <span className="truncate">
        The app wants to use{' '}
        <strong className="font-medium text-foreground">
          {serverId} · {name}
        </strong>
        {error && ` (${error})`}
      </span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(false)}>
        Not now
      </Button>
      <Button size="sm" disabled={busy} onClick={() => void allow()}>
        Allow
      </Button>
      {onOpen !== undefined && (
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open
        </Button>
      )}
    </div>
  )
}
