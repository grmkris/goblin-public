import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@goblin/ui'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import { useBilling } from '../account/hooks.ts'
import { featureLine, type UpgradePrompts } from '../lib/upgrade-prompt.ts'
import { reportUnexpected } from '../lib/unexpected.ts'

const none = () => undefined

/**
 * The calm ask an API call's `SubscriptionRequired` opens, wherever it came from (ADR 0054): what needs Pro, what Pro
 * costs, and See Pro, which comes back here once the owner has subscribed. Not now leaves the page as it was. It asks
 * only an account on a plan (the free one): one without any plan is already on its page's subscribe gate.
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
            {featureLine(ask?.feature)} $10 every 30 days in USDC, paid from your Goblin Wallet; cancel any time.
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
