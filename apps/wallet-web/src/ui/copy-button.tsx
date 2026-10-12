import { Button } from '@goblin/ui'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'

/** Copies a value and says so; a refused clipboard says that instead. Icon only unless `compact` is off. */
export function CopyButton({
  text,
  label,
  compact = false,
}: {
  readonly text: string
  readonly label: string
  readonly compact?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      // expected: a refused clipboard shows "Copy failed" beside the button
      setState('failed')
    }
  }
  const copied = state === 'copied'
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon-xs' : 'sm'}
        aria-label={copied ? `${label}: copied` : label}
        title={label}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {!compact && (copied ? 'Copied' : 'Copy')}
      </Button>
      {state === 'failed' && (
        <span role="status" className="text-xs text-destructive">
          Copy failed
        </span>
      )}
    </span>
  )
}
