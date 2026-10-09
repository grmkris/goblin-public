import * as Layer from 'effect/Layer'
import type { FoundationServices } from './core.ts'

/** Lane M's services: the MCP host and resident authority. Empty until the lane fills it; it may require any foundation service. */
export const McpLive: Layer.Layer<never, never, FoundationServices> = Layer.empty
