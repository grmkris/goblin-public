import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane A's services: apps and files. Empty until the lane fills it; it may require any foundation service. */
export const AppsLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
