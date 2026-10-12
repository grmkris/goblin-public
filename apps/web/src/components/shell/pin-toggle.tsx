// Pin to sidebar and Unpin from sidebar (ADR 0053), where the owner meets a server or an App: a server card's menu, an
// App's page menu and the bar above an App in its conversation.
import type { SidebarPin } from '@goblin/contracts'
import { Button, DropdownMenuItem } from '@goblin/ui'
import { PinIcon, PinOffIcon } from 'lucide-react'
import { targetOf } from '../../lib/pins.ts'
import { usePins } from '../../sidebar/hooks.ts'

/** Whether `pin` shows in the sidebar now, and the click that pins or unpins it. */
function usePinToggle(pin: SidebarPin) {
  const pins = usePins()
  const target = targetOf(pin)
  const pinned = pins.isPinned(target)
  return {
    pinned,
    label: pinned ? 'Unpin from sidebar' : 'Pin to sidebar',
    toggle: () => (pinned ? pins.unpin(target) : pins.pin(pin)),
  }
}

/** The menu item: Pin to sidebar, or Unpin from sidebar once it is there. */
export function PinMenuItem({ pin }: { readonly pin: SidebarPin }) {
  const { pinned, label, toggle } = usePinToggle(pin)
  return (
    <DropdownMenuItem onClick={toggle}>
      {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
      {label}
    </DropdownMenuItem>
  )
}

/** The same as an icon button, for the bar above an App in its conversation. */
export function PinButton({ pin }: { readonly pin: SidebarPin }) {
  const { pinned, label, toggle } = usePinToggle(pin)
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={toggle}>
      {pinned ? <PinOffIcon /> : <PinIcon />}
    </Button>
  )
}
