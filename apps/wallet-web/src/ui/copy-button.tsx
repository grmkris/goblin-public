import { Button } from '@goblin/ui'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from './cn.ts'

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
    // A compact copy button keeps its small look but takes a 40px target for a mouse (a touch already gets 44px from the
    // shared button); its neighbours keep 8px clear so the two targets never overlap.
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1',
        compact && 'pointer-fine:[&>button]:after:absolute pointer-fine:[&>button]:after:-inset-2',
      )}
    >
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
