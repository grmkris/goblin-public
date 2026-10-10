import { createContext, type ReactNode, useCallback, useState } from 'react'
import { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@goblin/ui'

/** Asks the owner before a link in a reply opens; absent outside the shell, where links open as links do. */
export const LinkConfirm = createContext<((href: string) => void) | undefined>(undefined)

/**
 * The one dialog every reply's links ask through. A reply is untrusted text that can name one place and point at
 * another, so the owner sees the whole address, and its host, before it opens (in a new tab, without a referrer).
 */
export function LinkConfirmProvider({ children }: { readonly children: ReactNode }) {
  const [href, setHref] = useState<string>()
  const ask = useCallback((next: string) => setHref(next), [])
  const host = href === undefined ? '' : (URL.parse(href)?.host ?? '')
  const open = () => {
    if (href !== undefined) window.open(href, '_blank', 'noopener,noreferrer')
    setHref(undefined)
  }
  return (
    <LinkConfirm value={ask}>
      {children}
      <Dialog open={href !== undefined} onOpenChange={(next) => (next ? undefined : setHref(undefined))}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col gap-3">
            <DialogTitle>Open this link?</DialogTitle>
            <DialogDescription>
              {host === '' ? (
                'It leaves Goblin.'
              ) : (
                <>
                  It goes to <b className="text-foreground">{host}</b>.
                </>
              )}
            </DialogDescription>
            <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{href}</p>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button type="button" onClick={open}>
                Open
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </LinkConfirm>
  )
}
