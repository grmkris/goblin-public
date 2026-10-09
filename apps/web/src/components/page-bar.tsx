import type { ReactNode } from 'react'
import { TopBar, TopBarTitle } from '@goblin/ui'
import { NavigationButton } from './shell/shell.tsx'

/** A page's top bar: on a phone the navigation's button, then the page's name and its actions. */
export function PageBar({ title, actions }: { readonly title: ReactNode; readonly actions?: ReactNode }) {
  return (
    <TopBar>
      <NavigationButton />
      <TopBarTitle>{title}</TopBarTitle>
      {actions}
    </TopBar>
  )
}
