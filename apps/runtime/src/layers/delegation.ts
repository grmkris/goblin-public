import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane D's services: delegation, Topics, Personas and organizing. Empty until the lane fills it; it may require any foundation service. */
export const DelegationLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
