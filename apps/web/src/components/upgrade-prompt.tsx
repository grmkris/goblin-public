import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@goblin/ui'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { useBilling } from '../account/hooks.ts'
import { proPrices } from '../lib/pro.ts'
import { featureLine, type UpgradePrompts } from '../lib/upgrade-prompt.ts'
import { reportUnexpected } from '../lib/unexpected.ts'

const none = () => undefined

/**
 * The calm ask an API call's `SubscriptionRequired` for a feature opens, wherever it came from (ADR 0054): what needs
 * Pro, what the day pass and monthly cost, and See Pro, which comes back here once the owner has subscribed. Not now
 * leaves the page as it was. It asks only an account with a plan: one without any has the composer's way to pick one.
 */
export function UpgradePrompt({ prompts }: { readonly prompts: UpgradePrompts }) {
  const ask = useSyncExternalStore(prompts.subscribe, prompts.current, none)
  const { state } = useBilling()
  const lapsed = state !== undefined && !state.active
  useEffect(() => {
    if (ask !== undefined && lapsed) prompts.clear()
  }, [ask, lapsed, prompts])
  const here = useLocation({ select: (location) => location.href })
  const navigate = useNavigate()
  const seePro = () => {
    const href = `${ask?.subscribe ?? '/subscribe'}?return=${encodeURIComponent(here)}`
    prompts.dismiss()
    navigate({ href }).catch((error: unknown) => {
      reportUnexpected(error)
      window.location.assign(href)
    })
  }
  return (
    <Dialog
      open={ask !== undefined && state?.active === true}
      onOpenChange={(next) => (next ? undefined : prompts.dismiss())}
    >
      <DialogContent className="max-w-md">
        <div className="flex flex-col gap-3">
          <DialogTitle>goblin Pro</DialogTitle>
          <DialogDescription>
            {featureLine(ask?.feature)} {proPrices(state?.catalog ?? [])} Cancel any time in your wallet.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>Not now</DialogClose>
            <Button type="button" onClick={seePro}>
              See Pro
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
