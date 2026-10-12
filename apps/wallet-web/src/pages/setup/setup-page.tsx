// `/setup`: the wallet's own onboarding, one task per screen without the console's navigation. A client that sends the
// owner here may add `?return=<url>`; once the wallet is ready, Done goes back there if the Worker vouches for it.
import { Button } from '@goblin/ui'
import type { Me } from '@goblin/wallet/contract'
import { Check } from 'lucide-react'
import { useMe, useReturnCheck } from '../../api/queries.tsx'
import { Link, useLocation } from '../../app/router.tsx'
import { Async } from '../../ui/async.tsx'
import { FocusPage } from '../focus.tsx'
import { SetupFlow } from './flow.tsx'
import { readySentence } from './model.ts'
import { doneTarget, returnParam } from './return.ts'

/** The wallet is ready: what the agent can do now, and the one way on. */
export function ReadyMark() {
  return (
    <span aria-hidden className="flex size-14 items-center justify-center rounded-full bg-moss text-moss-foreground">
      <Check className="size-7" strokeWidth={2.25} />
    </span>
  )
}

function Done({ me, back }: { readonly me: Me; readonly back: string | undefined }) {
  const checked = useReturnCheck(back)
  const target = doneTarget(checked.data)
  return (
    <section className="flex min-h-80 flex-col items-center justify-center gap-6 text-center">
      <ReadyMark />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Your wallet is ready</h1>
        <p className="text-base/relaxed text-muted-foreground text-pretty">{readySentence(me)}</p>
      </div>
      {target.href === '/' ? (
        <Button nativeButton={false} size="cta" className="w-full" render={<Link to="/" />}>
          {target.label}
        </Button>
      ) : (
        // The client's own page, in this tab: the owner came from it.
        <Button nativeButton={false} size="cta" className="w-full" render={<a href={target.href} />}>
          {target.label}
        </Button>
      )}
    </section>
  )
}

export function SetupPage() {
  const me = useMe()
  const { search } = useLocation()
  const back = returnParam(search)
  return (
    <FocusPage>
      <Async query={me} rows={3}>
        {(data) => <SetupFlow me={data} total={2} done={<Done me={data} back={back} />} />}
      </Async>
    </FocusPage>
  )
}
