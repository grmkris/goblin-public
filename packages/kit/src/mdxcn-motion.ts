// Adapted from mdxcn's graph-motion fillDelay; its ease, fadeUp and stagger are in kit.css.
// MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { CSSProperties } from 'react'

/** Entrance delays stop at 280 ms; CSS removes the animation and delay when reduced motion is requested. */
export const entrance = (index: number): CSSProperties => ({ animationDelay: `${Math.min(index * 40, 280)}ms` })
