import { CopyButton } from './copy-button.tsx'
import { cn } from './cn.ts'
import type { ChainKey } from '@goblin/wallet/contract'
import { addressUrl } from './chains.ts'
import { shortAddress } from './format.ts'

/** A shortened address that opens its explorer page, with a copy button for the full value. */
export function AddressChip({
  address,
  chain,
  label,
  className,
}: {
  readonly address: string
  readonly chain?: ChainKey
  readonly label?: string
  readonly className?: string
}) {
  const text = <span className="tabular-nums">{shortAddress(address)}</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 text-sm', className)}>
      {label !== undefined && <span className="me-1.5 truncate text-muted-foreground">{label}</span>}
      {chain === undefined ? (
        text
      ) : (
        <a
          href={addressUrl(chain, address)}
          target="_blank"
          rel="noreferrer"
          title={address}
          className="rounded-sm underline-offset-4 focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring pointer-fine:hover:underline"
        >
          {text}
        </a>
      )}
      <CopyButton text={address} label={`Copy address ${shortAddress(address)}`} compact />
    </span>
  )
}
