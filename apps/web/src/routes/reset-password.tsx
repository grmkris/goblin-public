import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Alert, AlertDescription, Button, Field, FieldGroup, FieldLabel, Input } from '@goblin/ui'
import { AuthShell } from '../components/auth-shell.tsx'
import { request } from '../lib/boundary.ts'

/** Where a password-reset link lands (Better Auth adds `token`, or `error` for a used or expired link). */
export const Route = createFileRoute('/reset-password')({ component: ResetPassword })

function ResetPassword() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [state, setState] = useState<'form' | 'done' | 'failed'>(token && !params.get('error') ? 'form' : 'failed')
  async function reset(): Promise<void> {
    setPending(true)
    try {
      await request('/api/auth/reset-password', { body: { newPassword: password, token } })
      setState('done')
    } catch {
      setState('failed')
    } finally {
      setPassword('')
      setPending(false)
    }
  }
  return (
    <AuthShell
      title="Choose a new password"
      description="Every device signed in to your account will be signed out."
      footer={
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      }
    >
      {state === 'form' && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void reset()
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" pending={pending}>
              Set password
            </Button>
          </FieldGroup>
        </form>
      )}
      {state === 'done' && (
        <Alert>
          <AlertDescription>Password changed. Sign in with the new one.</AlertDescription>
        </Alert>
      )}
      {state === 'failed' && (
        <Alert variant="destructive">
          <AlertDescription>
            This link has been used or has expired. Request a new one from the sign-in page.
          </AlertDescription>
        </Alert>
      )}
    </AuthShell>
  )
}
