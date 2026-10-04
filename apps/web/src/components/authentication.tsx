import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { request } from '../lib/boundary.ts'

function useAuthentication(onAuthenticated: () => void) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function signIn(bootstrap: boolean): Promise<void> {
    setPending(true)
    setError('')
    try {
      if (bootstrap) {
        const response = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-owner-bootstrap': token },
          body: JSON.stringify({ email, password, name: 'Owner' }),
        })
        setToken('')
        if (!response.ok) throw new Error(`Owner bootstrap failed (${response.status})`)
      }
      await request('/api/auth/sign-in/email', { email, password })
      setPassword('')
      onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed')
    } finally {
      setPending(false)
    }
  }
  return { email, setEmail, password, setPassword, token, setToken, pending, error, signIn }
}
type AuthenticationView = ReturnType<typeof useAuthentication>
function SignInForm({ view }: { readonly view: AuthenticationView }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void view.signIn(false)
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={view.email}
            onChange={(event) => view.setEmail(event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={view.password}
            onChange={(event) => view.setPassword(event.target.value)}
            minLength={8}
            required
          />
        </Field>
        <Field>
          <Button type="submit" disabled={view.pending}>
            {view.pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
function OwnerSetup({ view }: { readonly view: AuthenticationView }) {
  return (
    <details className="mt-6">
      <summary>First-time owner setup</summary>
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault()
          void view.signIn(true)
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bootstrap-token">Private bootstrap token</FieldLabel>
            <Input
              id="bootstrap-token"
              type="password"
              autoComplete="off"
              value={view.token}
              onChange={(event) => view.setToken(event.target.value)}
              required
            />
          </Field>
          <Field>
            <Button
              type="submit"
              variant="outline"
              disabled={view.pending || !view.email || !view.password || !view.token}
            >
              Create owner and sign in
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </details>
  )
}
export function Authentication({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const view = useAuthentication(onAuthenticated)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome to Purrable</CardTitle>
        <CardDescription>Sign in to your private resident workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <SignInForm view={view} />
        <OwnerSetup view={view} />
      </CardContent>
      <CardFooter>
        {view.error && (
          <Alert variant="destructive">
            <AlertDescription>{view.error}</AlertDescription>
          </Alert>
        )}
      </CardFooter>
    </Card>
  )
}
