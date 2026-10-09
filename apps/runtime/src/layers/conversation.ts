import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane C's services: conversation operations. Empty until the lane fills it; it may require any foundation service. */
export const ConversationLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
