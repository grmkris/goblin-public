// The bar at the top of a marketing page: the product's mark and name (the way home), a few links, Sign in and the
// page's one invitation. Translucent chrome the page scrolls under, with a soft lower edge instead of a border. On
// `moss` it is the hero's own green, so bar and hero read as one field; on `page` it is the page's material. It is
// 56px plus the notch. On a phone it keeps the mark and Sign in: the hero under it carries the invitation.
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { type SiteAction, type SiteLink, SiteButton } from './site-button.tsx'

export interface SiteBarProps {
  /** The product's name beside its mark, as it is written ("goblin", "Goblin Wallet"). */
  readonly name: string
  readonly mark: ReactNode
  /** Where the mark leads: the page's own top. */
  readonly home?: string
  /** A few links, shown where the bar has room. */
  readonly links?: readonly SiteLink[]
  readonly signIn?: SiteAction
  /** The page's one invitation, beside Sign in from a small tablet up. */
  readonly cta?: SiteAction
  readonly tone?: 'moss' | 'page'
}

export function SiteBar({ name, mark, home = '/', links = [], signIn, cta, tone = 'page' }: SiteBarProps) {
  return (
    <header
      data-slot="site-bar"
      data-tone={tone}
      className={cn('site-bar', tone === 'page' && 'material-chrome material-edge-bottom')}
    >
      <div className="site-width site-bar-row">
        <a href={home} className="site-brand">
          <span aria-hidden className="site-brand-tile">
            {mark}
          </span>
          {name}
        </a>
        <nav aria-label={name} className="site-nav">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="site-nav-link"
              {...(link.external === true && { rel: 'noopener' })}
            >
              {link.label}
            </a>
          ))}
          {signIn === undefined ? null : <SiteButton action={signIn} emphasis="quiet" size="bar" />}
          {cta === undefined ? null : <SiteButton action={cta} size="bar" />}
        </nav>
      </div>
    </header>
  )
}
