import type { ReactNode } from 'react'
import { SidebarTrigger, TopBar, TopBarTitle } from '@goblin/ui'

/** A page's top bar: the sidebar toggle, the page's name and its actions. */
export function PageBar({ title, actions }: { readonly title: ReactNode; readonly actions?: ReactNode }) {
  return (
    <TopBar>
      <SidebarTrigger />
      <TopBarTitle>{title}</TopBarTitle>
      {actions}
    </TopBar>
  )
}
