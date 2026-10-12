import type { ReactNode } from 'react'

/**
 * The view's outermost box: the host's safe-area insets (set on the root by `applyHostTheme`) added to the padding,
 * and a readable measure at full page.
 */
export function ViewFrame({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-5 text-foreground">{children}</main>
}

/** Shown until the host sends the tool result, and when the connection to the host fails. */
export function ViewStatus({ error, children }: { readonly error?: Error | null; readonly children: ReactNode }) {
  return (
    <p role={error ? 'alert' : 'status'} className="py-6 text-sm text-muted-foreground">
      {error ? `Could not connect to the host: ${error.message}` : children}
    </p>
  )
}
