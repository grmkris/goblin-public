// The foot of a marketing page: the product's mark and one line, then its links in titled groups (its own, the other
// product's, the legal pages), and the source code once it is public. The groups take as many columns as fit.
import type { ReactNode } from 'react'
import type { SiteLink } from './site-button.tsx'

export interface SiteLinkGroup {
  readonly title: string
  readonly links: readonly SiteLink[]
}

export interface SiteFooterProps {
  readonly name: string
  readonly mark: ReactNode
  /** One line under the name: what the product is, its licence. */
  readonly note?: ReactNode
  readonly groups: readonly SiteLinkGroup[]
  /** Where the source code is public. */
  readonly source?: string
  /** Shows the Source link: off until that repository is public, so a dead link never ships. */
  readonly showSource?: boolean
}

export function SiteFooter({ name, mark, note, groups, source, showSource = false }: SiteFooterProps) {
  const code: readonly SiteLinkGroup[] =
    showSource && source !== undefined
      ? [{ title: 'Code', links: [{ label: 'Source', href: source, external: true }] }]
      : []
  return (
    <footer data-slot="site-footer" className="site-footer">
      <div className="site-width site-footer-grid">
        <div className="site-footer-brand">
          <p className="site-footer-name">
            <span aria-hidden className="site-brand-tile">
              {mark}
            </span>
            {name}
          </p>
          {note === undefined ? null : <p className="site-small site-footer-note">{note}</p>}
        </div>
        <nav aria-label={`${name}, more`} className="site-footer-groups">
          {[...groups, ...code].map((group) => (
            <div key={group.title} className="site-footer-group">
              <h2>{group.title}</h2>
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="site-footer-link"
                      {...(link.external === true && { rel: 'noopener' })}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </footer>
  )
}
