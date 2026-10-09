import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane K's services: memory, retrieval and skills. Empty until the lane fills it; it may require any foundation service. */
export const KnowledgeLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
