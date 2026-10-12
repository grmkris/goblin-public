import { describe, expect, it } from 'vitest'
import { APP_MODES, hostContext, hostStyles, inlineHeight } from '../src/lib/host-context.ts'

const tokens: Record<string, string> = {
  '--background': ' oklch(0.2 0.006 255)',
  '--foreground': 'oklch(0.94 0.004 90)',
  '--border': 'oklch(1 0 0 / 10%)',
  '--radius-lg': '0.5rem',
  '--card': 'oklch(0.24 0.006 255)',
}
const read = (name: string) => tokens[name] ?? ''
const device = { dark: true, touch: false, hover: true, locale: 'en-GB', timeZone: 'Europe/Ljubljana' }

describe('the host context an MCP App receives', () => {
  it('maps our theme tokens to MCP Apps style variables and leaves out what the document lacks', () => {
    const styles = hostStyles(read)
    expect(styles['--color-background-primary']).toBe('oklch(0.2 0.006 255)')
    expect(styles['--color-text-inverse']).toBe('oklch(0.2 0.006 255)')
    expect(styles['--color-border-primary']).toBe('oklch(1 0 0 / 10%)')
    expect(styles['--border-radius-lg']).toBe('0.5rem')
    expect('--color-ring-primary' in styles).toBe(false)
    expect(styles['--font-sans']).toContain('system-ui')
  })
  it('describes the placement: inline Apps choose their height, other modes get a fixed box', () => {
    const inline = hostContext(read, device, { mode: 'inline', available: ['inline'], width: 640.4, height: 600 })
    expect(inline).toMatchObject({
      theme: 'dark',
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      containerDimensions: { width: 640, maxHeight: 600 },
      platform: 'web',
      deviceCapabilities: { touch: false, hover: true },
    })
    const panel = hostContext(
      read,
      { ...device, dark: false, touch: true, hover: false },
      {
        mode: 'fullscreen',
        available: [...APP_MODES],
        width: 390,
        height: 700,
      },
    )
    expect(panel).toMatchObject({
      theme: 'light',
      platform: 'mobile',
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { width: 390, height: 700 },
    })
  })
  it('tells an App on its page which screen edges it must clear, and says nothing of insets otherwise', () => {
    const page = hostContext(read, device, {
      mode: 'fullscreen',
      available: ['fullscreen'],
      width: 390,
      height: 760,
      surface: 'page',
      insets: { top: 0, right: 0, bottom: 34, left: 0 },
    })
    expect(page).toMatchObject({ surface: 'page', safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 } })
    const inline = hostContext(read, device, { mode: 'inline', available: ['inline'], width: 640, height: 600 })
    expect('safeAreaInsets' in inline).toBe(false)
  })
  it('keeps an inline App between a usable minimum and most of the viewport', () => {
    expect(inlineHeight(undefined, 900)).toBe(440)
    expect(inlineHeight(40, 900)).toBe(160)
    expect(inlineHeight(5000, 900)).toBe(630)
    expect(inlineHeight(5000, 200)).toBe(240)
  })
})
