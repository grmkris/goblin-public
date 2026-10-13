// What a marketing page offers its visitor: a link to follow (sign up, read more) or a button that acts in place (a
// sign-in that opens a dialog). One control on the moss field and on the page, in two weights (`marketing.css`).
import { Spinner } from '../components/spinner.tsx'

/** A link to follow, or something to do here (`pending` while it is under way). */
export type SiteAction =
  | { readonly label: string; readonly href: string }
  | { readonly label: string; readonly onClick: () => void; readonly pending?: boolean }

/** Where a link goes; `external` ones leave the site. */
export interface SiteLink {
  readonly label: string
  readonly href: string
  readonly external?: boolean
}

/**
 * `primary` is the page's one invitation, lichen on the moss field and moss on the page; `quiet` sits beside it. `bar`
 * is the top bar's denser size. Its colours follow where it sits (the moss field, the moss bar or the page).
 */
export function SiteButton({
  action,
  emphasis = 'primary',
  size = 'cta',
}: {
  readonly action: SiteAction
  readonly emphasis?: 'primary' | 'quiet'
  readonly size?: 'cta' | 'bar'
}) {
  if ('href' in action)
    return (
      <a className="site-button" data-emphasis={emphasis} data-size={size} href={action.href}>
        {action.label}
      </a>
    )
  const pending = action.pending === true
  return (
    <button
      type="button"
      className="site-button"
      data-emphasis={emphasis}
      data-size={size}
      aria-busy={pending}
      onClick={action.onClick}
    >
      {pending && <Spinner aria-hidden role={undefined} />}
      {action.label}
    </button>
  )
}
