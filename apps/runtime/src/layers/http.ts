import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane H's services: the HTTP API served in the agent. Empty until the lane fills it; it may require any foundation service. */
export const HttpLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
