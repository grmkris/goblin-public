// goblin's message composer: a floating card of the chrome material, set off by a hairline and glowing softly while
// it has focus, with a borderless input that grows with its text and a row of actions. The parts own the look; the app
// wires behaviour.
import type * as React from 'react'
import { cn } from '../lib/cn'

/** The floating card; a `<form>`, so Enter and the submit button share one path. */
function Composer({ className, ...props }: React.ComponentProps<'form'>) {
  return (
    <form
      data-slot="composer"
      className={cn(
        'material-chrome flex w-full flex-col gap-1 rounded-2xl border border-hairline p-1.5 shadow-(--shadow-2) transition-[border-color,box-shadow] duration-200 has-[textarea:focus-visible]:border-ring/60 has-[textarea:focus-visible]:shadow-(--shadow-3) has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/15',
        className,
      )}
      {...props}
    />
  )
}

/** Borderless and auto-growing, up to two fifths of the screen; then it scrolls. */
function ComposerInput({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="composer-input"
      rows={1}
      className={cn(
        'field-sizing-content max-h-[40dvh] min-h-11 w-full resize-none bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-busy:opacity-50 pointer-fine:md:text-[0.9375rem]',
        className,
      )}
      {...props}
    />
  )
}

/** The actions under the input: context on the left (status, model), the primary actions on the right. */
function ComposerActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="composer-actions" className={cn('flex min-h-8 items-center gap-2 px-1', className)} {...props} />
  )
}

export { Composer, ComposerActions, ComposerInput }
