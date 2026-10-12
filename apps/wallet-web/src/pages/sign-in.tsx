import { Button, GoblinMark } from '@goblin/ui'
import type { ReactNode } from 'react'
import { useAuth } from '../app/auth.tsx'
import { useLocation } from '../app/router.tsx'

/** The signed-out frame: the mark, one heading, one sentence and the action, in the wallet's narrow column. */
function Frame({
  title,
  children,
  action,
}: {
  readonly title: string
  readonly children: ReactNode
  readonly action: ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-10 px-(--page-gutter-left) py-12">
      <div aria-hidden className="h-(--safe-top)" />
      <div className="flex flex-col gap-4">
        <GoblinMark className="size-10" />
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-base/relaxed text-muted-foreground text-pretty">{children}</p>
      </div>
      <div className="flex flex-col gap-3">{action}</div>
      <div aria-hidden className="h-(--safe-bottom)" />
    </main>
  )
}

/** Signed out: what this is, in one sentence, and the one button. A sign-in that never finished gets a way out. */
export function SignInPage() {
  const auth = useAuth()
  const { pathname } = useLocation()
  if (auth.status === 'stalled') return <Stalled logout={auth.logout} />
  // A client sent the owner here to connect: say so, so the sign-in reads as the first step of that.
  const connecting = pathname === '/consent'
  return (
    <Frame
      title="Goblin Wallet"
      action={
        <>
          <Button type="button" size="cta" pending={auth.status === 'loading'} onClick={auth.login}>
            Sign in with email or X
          </Button>
          <p className="text-center text-xs/relaxed text-muted-foreground text-pretty">
            New here? Your wallet is created when you first sign in. Nothing is spent until you allow it.
          </p>
        </>
      }
    >
      {connecting
        ? 'Sign in to answer the connection request from your agent.'
        : "Your agent's wallet, with limits you set."}
    </Frame>
  )
}

function Stalled({ logout }: { readonly logout: () => void }) {
  return (
    <Frame
      title="Signing in did not finish"
      action={
        <>
          <Button type="button" size="cta" onClick={() => window.location.reload()}>
            Try again
          </Button>
          <Button type="button" size="cta" variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </>
      }
    >
      Your wallet did not load. Try again; if it still does not, sign out and sign in once more.
    </Frame>
  )
}
