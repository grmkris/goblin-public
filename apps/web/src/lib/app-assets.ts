// The frame runtime of agent app views (packages/app, dist/runtime): the bundles as hashed assets the sandbox loads by
// URL, and goblin's stylesheets, fetched with the first agent app the owner opens (ADR 0021).
import charts from '@goblin/app/runtime/charts.js?url'
import core from '@goblin/app/runtime/core.js?url'
import diagrams from '@goblin/app/runtime/diagrams.js?url'
import icons from '@goblin/app/runtime/icons.js?url'
import maps from '@goblin/app/runtime/maps.js?url'
import type { FrameAssets } from './app-sandbox.ts'

let styles: Promise<FrameAssets['styles']> | undefined

/** The frame's assets: absolute bundle URLs on this origin (the frame has none of its own) and the stylesheets. */
export async function frameAssets(): Promise<FrameAssets> {
  styles ??= Promise.all([import('@goblin/app/runtime/ui.css?raw'), import('@goblin/app/runtime/maps.css?raw')]).then(
    ([ui, map]) => ({ ui: ui.default, maps: map.default }),
  )
  const { origin } = window.location
  const absolute = (path: string) => new URL(path, origin).href
  return {
    origin,
    scripts: {
      core: absolute(core),
      charts: absolute(charts),
      maps: absolute(maps),
      diagrams: absolute(diagrams),
      icons: absolute(icons),
    },
    styles: await styles,
  }
}
