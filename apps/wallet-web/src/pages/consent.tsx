// `/consent?request=<id>`: an MCP client asks to connect. A wallet that is not set up yet is set up right here, inside
// the connection (Add funds, Turn on spending, then Approve), so the client gets a wallet that works; "Connect now,
// finish later" approves at once. While the page is open the request is kept alive, at most an hour.
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiFailure } from '../api/http-api.ts'
import { useMe, useOAuthDecide, useOAuthKeepAlive, useOAuthRequest } from '../api/queries.tsx'
import type { OAuthRequestView } from '../api/types.ts'
import { useAuth } from '../app/auth.tsx'
import { useLocation } from '../app/router.tsx'
import { errorText, LoadingBlock } from '../ui/async.tsx'
import { FocusPage } from './focus.tsx'
import { clientHome, type ConsentStage, consentStage, type Failure, KEEP_ALIVE_MS } from './setup/consent-model.ts'
import { SetupFlow } from './setup/flow.tsx'
import { readySentence } from './setup/model.ts'
import { StepDots } from './setup/ui.tsx'

/** Scopes in words. An unknown scope is shown as it came, so nothing is hidden behind a friendly name. */
const SCOPE_WORDS: Readonly<Record<string, string>> = {
  'wallet:read': 'See your balances, limits and activity.',
  'wallet:spend': 'Spend within your limits. Anything over a limit still asks you first.',
}

export const scopeWords = (scope: string): string => SCOPE_WORDS[scope] ?? scope

const failureOf = (error: unknown): Failure | undefined =>
  error === null || error === undefined
    ? undefined
    : { code: error instanceof ApiFailure ? error.code : undefined, message: errorText(error) }

/** Keeps the request pending while this page is open and live: every two minutes, and whenever it is shown again. */
function useKeepAlive(id: string, live: boolean): void {
  const keep = useOAuthKeepAlive(id)
  const send = useRef(keep.mutate)
  useEffect(() => {
    send.current = keep.mutate
  })
  useEffect(() => {
    if (!live) return undefined
    const tick = () => send.current()
    const timer = setInterval(tick, KEEP_ALIVE_MS)
    const onShow = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [live])
}

/** The answer, and the browser on its way back to the client with it. */
function useAnswer(id: string) {
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
  return { answer, busy: decide.isPending || followed, error: decide.isError ? errorText(decide.error) : undefined }
}

type Answer = ReturnType<typeof useAnswer>

function ApproveCard({
  view,
  answer,
  ready,
}: {
  readonly view: OAuthRequestView
  readonly answer: Answer
  /** The owner just finished setup here: say so, and number this as its last step. */
  readonly ready: string | undefined
}) {
  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {ready !== undefined && <StepDots step={3} total={3} />}
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{view.client} wants to use your wallet</h1>
        <p className="text-base/relaxed text-muted-foreground text-pretty">
          After you answer, you go back to <strong className="font-medium text-foreground">{view.redirectHost}</strong>.
          Only continue if you started this there.
        </p>
      </header>
      {ready !== undefined && (
        <p role="status" className="flex items-start gap-3 rounded-xl bg-muted/50 p-4 text-sm/relaxed text-pretty">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            <span className="font-medium">Your wallet is ready.</span> {ready}
          </span>
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {view.scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-3 text-base/relaxed">
            <Check aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
            {scopeWords(scope)}
          </li>
        ))}
      </ul>
      {answer.error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{answer.error} You can try again.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Button type="button" size="cta" pending={answer.busy} onClick={() => answer.answer('approve')}>
          Approve
        </Button>
        <Button type="button" size="cta" variant="ghost" disabled={answer.busy} onClick={() => answer.answer('deny')}>
          Deny
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground">This request stays open while this page is.</p>
    </section>
  )
}

/** Setup first, inside the connection; the quiet way out connects now and leaves setup for later. */
function SetupFirst({
  stage,
  answer,
}: {
  readonly stage: Extract<ConsentStage, { kind: 'setup' }>
  readonly answer: Answer
}) {
  const { view, me } = stage
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{view.client} wants to use your wallet</h1>
        <p className="text-base/relaxed text-muted-foreground text-pretty">
          First, set up your wallet (about 2 minutes).
        </p>
      </header>
      {/* Done is never shown here: a wallet that is set up turns this page into Approve. */}
      <SetupFlow me={me} client={view.client} total={3} level={2} done={null} />
      <div className="flex flex-col items-center gap-2 border-t border-border pt-6">
        {answer.error !== undefined && <p className="text-sm text-destructive">{answer.error}</p>}
        {/* Quiet on purpose: setup is the way on; this one connects a wallet that cannot pay yet. */}
        <button
          type="button"
          disabled={answer.busy}
          onClick={() => answer.answer('approve')}
          className="relative rounded-sm px-2 py-1 text-sm text-muted-foreground underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-fine:hover:text-foreground pointer-fine:hover:underline"
        >
          Connect now, finish later
        </button>
      </div>
    </div>
  )
}

function Expired({ view }: { readonly view: OAuthRequestView }) {
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight text-balance">This request expired</h1>
      <p className="text-base/relaxed text-muted-foreground text-pretty">
        Go back to {view.redirectHost} and connect again. What you set up here is kept.
      </p>
      <Button nativeButton={false} size="cta" render={<a href={clientHome(view.redirectHost)} />}>
        Back to {view.redirectHost}
      </Button>
    </section>
  )
}

function Stopped({ title, children }: { readonly title: string; readonly children: string }) {
  const auth = useAuth()
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
      <p className="text-base/relaxed text-muted-foreground text-pretty">{children}</p>
      <Button type="button" variant="outline" size="cta" onClick={auth.logout}>
        Sign out
      </Button>
    </section>
  )
}

function Stage({
  stage,
  answer,
  readied,
}: {
  readonly stage: ConsentStage
  readonly answer: Answer
  /** Setup was finished on this page. */
  readonly readied: boolean
}) {
  switch (stage.kind) {
    case 'no-request':
      return <Stopped title="No request in this link">Start again from your client.</Stopped>
    case 'loading':
      return <LoadingBlock rows={3} />
    case 'gone':
      return <Stopped title="This request was already answered">Start again from your client if you need to.</Stopped>
    case 'other-owner':
      return <Stopped title="This request is for another account">{stage.message}</Stopped>
    case 'failed':
      return <Stopped title="This request could not be loaded">{stage.message}</Stopped>
    case 'expired':
      return <Expired view={stage.view} />
    case 'setup':
      return <SetupFirst stage={stage} answer={answer} />
    case 'approve':
      return <ApproveCard view={stage.view} answer={answer} ready={readied ? readySentence(stage.me) : undefined} />
  }
}

export function ConsentPage() {
  const { search } = useLocation()
  const id = search.get('request') ?? ''
  const request = useOAuthRequest(id)
  const me = useMe()
  const answer = useAnswer(id)
  const stage = consentStage({
    id,
    request: request.data,
    requestFailure: request.data === undefined ? failureOf(request.error) : undefined,
    me: me.data,
    meFailure: me.data === undefined ? failureOf(me.error) : undefined,
  })
  // Setup shown on this page and then finished: Approve says the wallet is ready and counts as its last step.
  const [setUpHere, setSetUpHere] = useState(false)
  if (stage.kind === 'setup' && !setUpHere) setSetUpHere(true)
  useKeepAlive(id, stage.kind === 'setup' || stage.kind === 'approve')
  return (
    <FocusPage>
      <Stage stage={stage} answer={answer} readied={setUpHere} />
    </FocusPage>
  )
}
