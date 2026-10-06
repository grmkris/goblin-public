import type { TileSize } from '@goblin/contracts'
import type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiStyles,
  McpUiStyleVariableKey,
} from '@modelcontextprotocol/ext-apps/app-bridge'

/** Reads one of the host's CSS custom properties, as computed on the document (variables already substituted). */
export type TokenReader = (name: string) => string

/** Which of our theme tokens answers each MCP Apps style variable an App may read. */
const THEMED: readonly (readonly [McpUiStyleVariableKey, string])[] = [
  ['--color-background-primary', '--background'],
  ['--color-background-secondary', '--card'],
  ['--color-background-tertiary', '--muted'],
  ['--color-background-inverse', '--foreground'],
  ['--color-background-danger', '--destructive'],
  ['--color-background-disabled', '--muted'],
  ['--color-text-primary', '--foreground'],
  ['--color-text-secondary', '--muted-foreground'],
  ['--color-text-tertiary', '--muted-foreground'],
  ['--color-text-inverse', '--background'],
  ['--color-text-danger', '--destructive'],
  ['--color-text-disabled', '--muted-foreground'],
  ['--color-border-primary', '--border'],
  ['--color-border-secondary', '--input'],
  ['--color-border-danger', '--destructive'],
  ['--color-ring-primary', '--ring'],
  ['--border-radius-sm', '--radius-sm'],
  ['--border-radius-md', '--radius-md'],
  ['--border-radius-lg', '--radius-lg'],
  ['--border-radius-xl', '--radius-xl'],
]

/**
 * Values that do not depend on the theme. Fonts are a stack only: an App's CSP will not load files from our origin,
 * so it gets Geist where the device has it and the system face otherwise.
 */
const FIXED: Partial<McpUiStyles> = {
  '--color-background-ghost': 'transparent',
  '--font-sans': "'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif",
  '--font-mono': "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',
  '--font-text-xs-size': '0.75rem',
  '--font-text-sm-size': '0.875rem',
  '--font-text-md-size': '1rem',
  '--font-text-lg-size': '1.125rem',
  '--font-text-xs-line-height': '1rem',
  '--font-text-sm-line-height': '1.25rem',
  '--font-text-md-line-height': '1.5rem',
  '--font-text-lg-line-height': '1.75rem',
  '--font-heading-sm-size': '1rem',
  '--font-heading-md-size': '1.25rem',
  '--font-heading-lg-size': '1.5rem',
  '--border-radius-full': '9999px',
  '--border-width-regular': '1px',
}

/** Our theme as MCP Apps style variables; tokens the document does not define are left out. */
export function hostStyles(read: TokenReader, surface?: AppPlacement['surface']): McpUiStyles {
  const styles: Partial<McpUiStyles> = { ...FIXED }
  for (const [key, token] of THEMED) {
    const value = read(surface === 'home' && key === '--color-background-primary' ? '--card' : token).trim()
    if (value !== '') styles[key] = value
  }
  // SAFETY: McpUiStyles is Record<key, string | undefined>; a key that is absent reads as undefined, as the type allows.
  return styles as McpUiStyles
}

/** Where the App is shown and how much room it has there. */
export type AppPlacement = {
  readonly mode: McpUiDisplayMode
  readonly available: readonly McpUiDisplayMode[]
  readonly width: number
  /** Fixed on its page; inline the App picks its height up to this. */
  readonly height: number
  readonly surface?: 'inline' | 'home' | 'page'
  readonly tileSize?: TileSize
}

export type Device = {
  readonly dark: boolean
  readonly touch: boolean
  readonly hover: boolean
  readonly locale: string
  readonly timeZone: string
}

/** The display modes this host offers: in its place in the transcript, or as a page of its own (fullscreen). */
export const APP_MODES: readonly McpUiDisplayMode[] = ['inline', 'fullscreen']

/** Everything an App learns about the host: theme, styles, device and its own placement. Never the owner's data. */
export function hostContext(read: TokenReader, device: Device, placement: AppPlacement): McpUiHostContext {
  const width = Math.round(placement.width)
  const height = Math.round(placement.height)
  return {
    theme: device.dark ? 'dark' : 'light',
    styles: { variables: hostStyles(read, placement.surface) },
    displayMode: placement.mode,
    availableDisplayModes: [...placement.available],
    containerDimensions:
      placement.mode === 'inline' && placement.surface !== 'home' ? { width, maxHeight: height } : { width, height },
    surface: placement.surface ?? (placement.mode === 'inline' ? 'inline' : 'page'),
    tileSize: placement.tileSize ?? null,
    locale: device.locale,
    timeZone: device.timeZone,
    platform: device.touch && !device.hover ? 'mobile' : 'web',
    deviceCapabilities: { touch: device.touch, hover: device.hover },
  }
}

/** The height an inline App asked for, kept between a usable minimum and most of the viewport. */
export function inlineHeight(requested: number | undefined, viewport: number): number {
  const most = Math.max(240, Math.round(viewport * 0.7))
  return Math.min(most, Math.max(160, Math.round(requested ?? 440)))
}
