import { Button, Card, CardContent, GoblinMark, Spinner } from '@goblin/ui'
import { useAuth } from '../app/auth.tsx'

/** Signed out: what this is, in one sentence, and the one button. */
export function SignInPage() {
  const auth = useAuth()
  const loading = auth.status === 'loading'
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-(--page-gutter-left) py-12">
      <div className="flex flex-col gap-3">
        <GoblinMark className="size-8" />
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Goblin Wallet</h1>
        <p className="text-base/relaxed text-muted-foreground text-pretty">
          Your agent&apos;s wallet, with limits you set. You decide how much it can spend; the chain enforces it.
        </p>
      </div>
      <Card>
        <CardContent>
          <div className="flex flex-col gap-3">
            <Button type="button" size="lg" disabled={loading} onClick={auth.login}>
              {loading && <Spinner data-icon="inline-start" />}
              Sign in with email or Google
            </Button>
            <p className="text-xs/relaxed text-muted-foreground">
              We create an account for you on first sign-in. Nothing is spent until you give your agent an allowance.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
