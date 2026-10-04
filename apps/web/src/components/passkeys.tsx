import { useCallback, useEffect, useState } from 'react'
import {
  type AuthActionResult,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PasskeyManager,
  type PasskeySummary,
  failed,
  succeeded,
} from '@purrable/ui'
import { authClient } from '../lib/auth-client.ts'
import { signOut } from '../lib/session.tsx'

/** Adding a passkey needs a sign-in from the last 10 minutes: the runtime's `session.freshAge` (600 s). */
const FRESH_MS = 10 * 60 * 1000

/** The signed-in user's passkeys: list, add (named) and remove, through Better Auth's passkey endpoints. */
export function PasskeysCard({ onError }: { readonly onError: (message: string) => void }) {
  const [passkeys, setPasskeys] = useState<readonly PasskeySummary[]>()
  const [fresh, setFresh] = useState(false)
  const load = useCallback(async () => {
    const [list, session] = await Promise.all([authClient.passkey.listUserPasskeys(), authClient.getSession()])
    if (list.error) {
      onError('Could not load your passkeys.')
      return
    }
    setPasskeys(
      list.data.map(({ id, name, createdAt, backedUp }) => ({ id, name: name ?? undefined, createdAt, backedUp })),
    )
    const created = session.data?.session.createdAt
    setFresh(created !== undefined && Date.now() - new Date(created).getTime() < FRESH_MS)
  }, [onError])
  useEffect(() => {
    void load()
  }, [load])
  const add = async (name: string): Promise<AuthActionResult> => {
    const result = await authClient.passkey.addPasskey({ name })
    if (result?.error) return failed('Could not add the passkey.')
    await load()
    return succeeded
  }
  const remove = async (id: string): Promise<AuthActionResult> => {
    const result = await authClient.passkey.deletePasskey({ id })
    if (result.error) return failed('Could not remove the passkey.')
    await load()
    return succeeded
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in with this device’s screen lock: no code, no password. Emailed codes and your password keep working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {passkeys === undefined ? null : (
          <PasskeyManager
            passkeys={passkeys}
            freshSession={fresh}
            onAdd={add}
            onRemove={remove}
            onReauthenticate={() => void signOut('/settings')}
            suggestedName={`Purrable on ${navigator.platform || 'this device'}`}
          />
        )}
      </CardContent>
    </Card>
  )
}
