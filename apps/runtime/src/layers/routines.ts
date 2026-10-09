import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane R's services: routines, the channel and billing. Empty until the lane fills it; it may require any foundation service. */
export const RoutinesLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
