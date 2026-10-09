import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane O's services: telemetry, inspection and flows. Empty until the lane fills it; it may require any foundation service. */
export const ObservabilityLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
