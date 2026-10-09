import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from './button.tsx'

/** Copies the full value, with visible feedback when browser clipboard access is unavailable. */
function CopyButton({
  text,
  label,
  compact = false,
}: {
  readonly text: string | (() => string)
  readonly label: string
  readonly compact?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(typeof text === 'string' ? text : text())
      setState('copied')
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
        variant="ghost"
        size={compact ? 'icon-xs' : 'xs'}
        aria-label={copied ? `${label}: copied` : label}
        title={label}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
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

export { CopyButton }
