// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
import { LoaderCircleIcon, type LucideIcon } from 'lucide-react'

/** The leading icon of an action button; a turning circle while the action runs (the label stays, so does the size). */
export function ActionIcon({ icon: Icon, busy = false }: { readonly icon: LucideIcon; readonly busy?: boolean }) {
  return busy ? (
    <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
  ) : (
    <Icon data-icon="inline-start" />
  )
}
