import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from '@purrable/ui'
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
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>Every device signed in to your account will be signed out.</CardDescription>
      </CardHeader>
      <CardContent>
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
              <Field>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Saving…' : 'Set password'}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        )}
        {state === 'done' && (
          <Alert>
            <AlertDescription>
              Password changed. <a href="/">Sign in</a> with the new one.
            </AlertDescription>
          </Alert>
        )}
        {state === 'failed' && (
          <Alert variant="destructive">
            <AlertDescription>
              This link has been used or has expired. <a href="/">Request a new one</a> from the sign-in page.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
