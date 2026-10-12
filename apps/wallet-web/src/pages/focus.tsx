import { GoblinMark } from '@goblin/ui'
import type { ReactNode } from 'react'

/** A page the owner lands on from outside (an OAuth redirect, an approval link): one column, no navigation. */
export function FocusPage({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-(--page-gutter-left) py-8">
      <div aria-hidden className="-mb-6 h-(--safe-top)" />
      <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <GoblinMark className="size-5" />
        Goblin Wallet
      </div>
      {children}
      <div aria-hidden className="h-(--safe-bottom)" />
    </main>
  )
}
