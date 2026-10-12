import { type ApprovalView, termsHash } from '@goblin/wallet/contract'
import { useEffect, useState } from 'react'

export type TermsCheck = 'checking' | 'match' | 'mismatch'

/** Rebuilds the hash from the terms on screen and compares it with the one the server froze. */
export function useTermsCheck(view: ApprovalView | undefined): TermsCheck {
  const [result, setResult] = useState<{ readonly key: string; readonly check: TermsCheck }>()
  const key = view === undefined ? undefined : `${view.operationId}:${view.termsHash}`
  useEffect(() => {
    if (view === undefined || key === undefined) return
    let live = true
    termsHash(view.terms).then(
      (rebuilt) => {
        if (live)
          setResult({ key, check: rebuilt.toLowerCase() === view.termsHash.toLowerCase() ? 'match' : 'mismatch' })
      },
      () => {
        if (live) setResult({ key, check: 'mismatch' })
      },
    )
    return () => {
      live = false
    }
  }, [view, key])
  return result?.key === key && result !== undefined ? result.check : 'checking'
}
