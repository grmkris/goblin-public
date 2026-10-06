import type { ComponentProps } from 'react'
import { AuthPage } from '@purrable/ui'
import { CatIcon } from 'lucide-react'

/**
 * A page outside the workspace (signing in, subscribing, an app's consent, the policies): Purrable's mark, a title
 * and a line of context, then one column and a quiet footer with the way on or back. The root already renders the
 * page's `<main>` and pads it.
 */
export function AuthShell(props: Omit<ComponentProps<typeof AuthPage>, 'mark' | 'as'>) {
  return <AuthPage as="section" mark={<CatIcon />} {...props} />
}
