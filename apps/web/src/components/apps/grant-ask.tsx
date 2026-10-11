// When an App calls a tool the owner has not granted, its call waits on a card the host draws in the App's chrome,
// naming the exact tool. Allow grants that tool and retries; "Not now", or two minutes without an answer, fails the
// call as denied. The App's own words never reach this card; only the tool name it called does.
import { useCallback, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { KeyRoundIcon } from 'lucide-react'
import { GrantDenied } from '@goblin/contracts/api'
import { Button } from '@goblin/ui'
import { toolGrantMutation } from '../../mcp/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'

const WAIT_MS = 120_000

type Pending = { readonly name: string; readonly settle: (allowed: boolean) => void }

/** The owner's answer for one tool, asked once however many calls wait on it. */
export function useAppGrantAsks(connectionId: string) {
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
      <AppGrantCard connectionId={connectionId} name={first} onAnswer={(allowed) => answer(first, allowed)} />
    )
  return { ask, card }
}

/** True when an App's tool call failed only because the owner has not granted that tool. */
export function grantDenied(cause: unknown): boolean {
  return cause instanceof GrantDenied
}

function AppGrantCard({
  connectionId,
  name,
  onAnswer,
}: {
  readonly connectionId: string
  readonly name: string
  readonly onAnswer: (allowed: boolean) => void
}) {
  const allow = useMutation(toolGrantMutation)
  const busy = allow.isPending || allow.isSuccess
  const error = allow.error === null ? '' : messageOf(allow.error, 'allow the tool')
  return (
    <div className="app-offer" role="alertdialog" aria-label="Permission request from the app">
      <KeyRoundIcon aria-hidden />
      <span className="truncate">
        The app wants to use{' '}
        <strong className="font-medium text-foreground">
          {connectionId} · {name}
        </strong>
        {error && ` (${error})`}
      </span>
      <Button variant="ghost" size="app-action" disabled={busy} onClick={() => onAnswer(false)}>
        Not now
      </Button>
      <Button
        size="app-action"
        disabled={busy}
        onClick={() => allow.mutate({ connectionId, name, allowed: true }, { onSuccess: () => onAnswer(true) })}
      >
        Allow
      </Button>
    </div>
  )
}
