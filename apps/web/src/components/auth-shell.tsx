import type { ComponentProps } from 'react'
import { AuthPage, GoblinMark } from '@goblin/ui'

/**
 * A page outside the workspace (signing in, subscribing, an app's consent, the policies): goblin's mark, a title
 * and a line of context, then one column and a quiet footer with the way on or back. The root already renders the
 * page's `<main>` and pads it.
 */
export function AuthShell(props: Omit<ComponentProps<typeof AuthPage>, 'mark' | 'as'>) {
  return <AuthPage as="section" mark={<GoblinMark />} {...props} />
}
