// The host's look, mapped onto our tokens. The frame is an opaque origin that cannot load our stylesheet from the
// wallet's origin, so the views carry the wallet's own light and dark tokens and borrow the host's colours when it
// sends them (`hostContext.styles.variables`), keeping the card inside a goblin chat (or another host) in step.
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps'

type HostVariables = Partial<NonNullable<NonNullable<McpUiHostContext['styles']>['variables']>>

/** Our token and the host variables that answer it, first one present wins. */
const MAP: readonly (readonly [token: string, hosts: readonly (keyof HostVariables)[]])[] = [
  ['--background', ['--color-background-primary']],
  ['--card', ['--color-background-secondary', '--color-background-primary']],
  ['--muted', ['--color-background-tertiary', '--color-background-secondary']],
  ['--secondary', ['--color-background-tertiary']],
  ['--accent', ['--color-background-tertiary']],
  ['--popover', ['--color-background-secondary', '--color-background-primary']],
  ['--foreground', ['--color-text-primary']],
  ['--card-foreground', ['--color-text-primary']],
  ['--popover-foreground', ['--color-text-primary']],
  ['--secondary-foreground', ['--color-text-primary']],
  ['--accent-foreground', ['--color-text-primary']],
  ['--primary', ['--color-background-inverse', '--color-text-primary']],
  ['--primary-foreground', ['--color-text-inverse', '--color-background-primary']],
  ['--muted-foreground', ['--color-text-secondary', '--color-text-tertiary']],
  ['--destructive', ['--color-text-danger', '--color-background-danger']],
  ['--border', ['--color-border-primary']],
  ['--input', ['--color-border-secondary', '--color-border-primary']],
  ['--ring', ['--color-ring-primary']],
  ['--font-sans', ['--font-sans']],
]

/** The tokens the host's variables set. Colours stay ours where the host sends nothing, as the spec asks. */
export function tokensFromHost(variables: HostVariables | undefined): Record<string, string> {
  const tokens: Record<string, string> = {}
  if (variables === undefined) return tokens
  for (const [token, hosts] of MAP) {
    for (const name of hosts) {
      const value = variables[name]
      if (typeof value === 'string' && value.trim() !== '') {
        tokens[token] = value.trim()
        break
      }
    }
  }
  return tokens
}

let applied: readonly string[] = []

/** Applies the host's theme and variables to the document; clears what an earlier context set and this one does not. */
export function applyHostTheme(context: McpUiHostContext | undefined, root: HTMLElement = document.documentElement) {
  const dark =
    context?.theme === undefined ? matchMedia('(prefers-color-scheme: dark)').matches : context.theme === 'dark'
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  const tokens = tokensFromHost(context?.styles?.variables)
  for (const name of applied) if (!(name in tokens)) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value)
  applied = Object.keys(tokens)
  for (const [side, px] of Object.entries(insetsOf(context))) root.style.setProperty(`--inset-${side}`, `${px}px`)
}

/** Safe-area insets in px; hosts may send none. */
export function insetsOf(context: McpUiHostContext | undefined) {
  const insets = context?.safeAreaInsets
  return { top: insets?.top ?? 0, right: insets?.right ?? 0, bottom: insets?.bottom ?? 0, left: insets?.left ?? 0 }
}
