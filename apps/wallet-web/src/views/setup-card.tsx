// The dashboard App's lead while the wallet is not ready for its agent: what is missing, as a short checklist, and one
// way on, the wallet's own /setup, opened through the host like every link.
import { buttonVariants } from '@goblin/ui'
import { Circle, ExternalLink } from 'lucide-react'
import { notReadyTitle } from './setup-model.ts'

export function SetupCard({
  client,
  checklist,
  site,
}: {
  /** The agent's host by its own name; "your agent" without one. */
  readonly client: string | undefined
  readonly checklist: readonly string[]
  /** The wallet's site, whose /setup finishes it. */
  readonly site: string | undefined
}) {
  return (
    <section
      aria-label="Finish setup"
      className="flex flex-col gap-5 rounded-2xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold tracking-tight text-balance">{notReadyTitle(client)}</h2>
        <p className="text-sm/relaxed text-muted-foreground text-pretty">
          Finish setup in your wallet and {client ?? 'your agent'} can pay for what it uses, within limits you set.
        </p>
      </div>
      {checklist.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {checklist.map((item) => (
            <li key={item} className="flex items-center gap-3 text-sm">
              <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {item}
            </li>
          ))}
        </ul>
      )}
      {site === undefined ? (
        <p className="text-sm text-muted-foreground">Open your wallet to finish setup.</p>
      ) : (
        <a href={`${site}/setup`} className={buttonVariants({ size: 'cta', className: 'w-full' })}>
          Finish setup
          <ExternalLink aria-hidden data-icon="inline-end" />
        </a>
      )}
    </section>
  )
}
