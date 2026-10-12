import { Alert, AlertDescription, Button, Card, CardContent, Spinner } from '@goblin/ui'
import { useState } from 'react'
import { useOAuthDecide, useOAuthRequest } from '../api/queries.tsx'
import { useLocation } from '../app/router.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { timeUntil } from '../ui/index.ts'
import { FocusPage } from './focus.tsx'

/** Scopes in words. An unknown scope is shown as it came, so nothing is hidden behind a friendly name. */
const SCOPE_WORDS: Readonly<Record<string, string>> = {
  'wallet:read': 'See your balances, limits and activity.',
  'wallet:spend': 'Spend within your limits. Anything over a limit still asks you first.',
}

export const scopeWords = (scope: string): string => SCOPE_WORDS[scope] ?? scope

/** `/consent?request=<id>`: an MCP client asks to connect; the owner approves or denies and is sent back. */
export function ConsentPage() {
  const { search } = useLocation()
  const id = search.get('request') ?? ''
  const request = useOAuthRequest(id)
  const decide = useOAuthDecide(id)
  const [followed, setFollowed] = useState(false)
  const answer = (decision: 'approve' | 'deny'): void => {
    decide.mutate(decision, {
      onSuccess: ({ redirectTo }) => {
        setFollowed(true)
        window.location.assign(redirectTo)
      },
    })
  }
  const busy = decide.isPending || followed
  return (
    <FocusPage>
      {id === '' ? (
        <Alert variant="destructive">
          <AlertDescription>This link has no request in it. Start again from your client.</AlertDescription>
        </Alert>
      ) : (
        <Async query={request}>
          {(view) => (
            <Card>
              <CardContent>
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-2">
                    <h1 className="text-2xl font-semibold tracking-tight text-balance">
                      {view.client} wants to use your wallet
                    </h1>
                    <p className="text-sm/relaxed text-muted-foreground">
                      After you answer, you go back to{' '}
                      <strong className="font-medium text-foreground">{view.redirectHost}</strong>. Only continue if you
                      started this from that client.
                    </p>
                  </div>
                  <ul className="flex flex-col gap-2 border-y border-border py-4 text-sm/relaxed">
                    {view.scopes.map((scope) => (
                      <li key={scope}>{scopeWords(scope)}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">This request expires {timeUntil(view.expiresAt)}.</p>
                  {decide.isError && (
                    <Alert variant="destructive">
                      <AlertDescription>{errorText(decide.error)} You can try again.</AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row-reverse">
                    <Button
                      type="button"
                      size="lg"
                      disabled={busy}
                      onClick={() => answer('approve')}
                      className="sm:flex-1"
                    >
                      {busy && <Spinner data-icon="inline-start" />}
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="lg"
                      variant="outline"
                      disabled={busy}
                      onClick={() => answer('deny')}
                      className="sm:flex-1"
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </Async>
      )}
    </FocusPage>
  )
}
