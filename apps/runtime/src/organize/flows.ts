import type { FlowEvent } from '@goblin/contracts/telemetry'

/** Where an organizing change came in: the owner's app, or the agent's organize tools. */
export const viaOf = (actor: 'owner' | 'agent'): FlowEvent['via'] => (actor === 'owner' ? 'app' : 'tool')
