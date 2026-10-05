// Geometry the App stage shares with its slots. Pure.

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The host's own bar above every App: its name, where it is shown and close. Apps cannot draw over it. */
export const CHROME_HEIGHT = 36
