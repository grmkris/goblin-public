// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
/**
 * The page every app's sign-in, sign-up, consent, device and sign-in settings screens share: the product's mark, a
 * title and one line of context, then the task in one column, and a quiet footer line. The same layout in every app
 * keeps the apps identical; the app keeps only its words, its mark and its callbacks.
 */
import type * as React from 'react'
import { cn } from '../lib/cn.ts'

export interface AuthPageProps extends Omit<React.ComponentProps<'main'>, 'title'> {
  /** The product's mark (an icon or a logo), shown in a tile above the title. */
  readonly mark?: React.ReactNode
  readonly title: React.ReactNode
  /** One short line of context under the title. */
  readonly description?: React.ReactNode
  /** One quiet line under the task, such as the link to create an account. */
  readonly footer?: React.ReactNode
  /** `sm` (24rem) for sign-in and sign-up; `lg` (32rem) for consent, device approval and settings. */
  readonly size?: 'sm' | 'lg'
  /**
   * `main` (the default) is the page's landmark, with its own safe-area padding. Inside an app shell that already
   * renders `<main>` and pads the page, use `section`.
   */
  readonly as?: 'main' | 'section'
}

export function AuthPage({
  mark,
  title,
  description,
  footer,
  size = 'sm',
  as: Element = 'main',
  className,
  children,
  ...props
}: AuthPageProps) {
  return (
    <Element
      data-slot="auth-page"
      className={cn(
        'w-full min-w-0',
        Element === 'main'
          ? 'pt-10 pr-(--page-gutter-right) pb-(--page-gutter-bottom) pl-(--page-gutter-left) sm:pt-16'
          : 'pt-2 pb-8 sm:pt-6',
        className,
      )}
      {...props}
    >
      <div className={cn('mx-auto flex w-full flex-col gap-8', size === 'sm' ? 'max-w-sm' : 'max-w-lg')}>
        <header className="flex flex-col gap-5">
          {mark === undefined ? null : (
            <div
              data-slot="auth-page-mark"
              aria-hidden="true"
              className="flex size-11 items-center justify-center rounded-xl border bg-card text-foreground shadow-xs [&_svg:not([class*='size-'])]:size-5"
            >
              {mark}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl/tight font-semibold tracking-tight text-balance">{title}</h1>
            {description === undefined ? null : (
              <p className="text-sm/relaxed text-pretty text-muted-foreground">{description}</p>
            )}
          </div>
        </header>
        {children}
        {footer === undefined ? null : (
          <footer
            data-slot="auth-page-footer"
            className="flex flex-col gap-2 text-sm/relaxed text-pretty text-muted-foreground [&_a,&_button]:font-medium [&_a,&_button]:text-foreground [&_a,&_button]:underline [&_a,&_button]:underline-offset-4"
          >
            {footer}
          </footer>
        )}
      </div>
    </Element>
  )
}
