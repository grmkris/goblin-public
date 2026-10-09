import { Schema } from 'effect'
import { type AgentAppChange, AgentAppDetail } from '@goblin/contracts'
import { request } from './boundary.ts'

// What the conversation's power ask (parts/app-powers.tsx) still reads and changes by hand; the Apps pages use the
// typed factories in agent-apps/queries.ts, which this file gives way to once that ask moves over.
const decodeDetail = Schema.decodeUnknownSync(AgentAppDetail)
const pathOf = (name: string) => `/api/agent-apps/${encodeURIComponent(name)}`

/** One agent app in full. */
export const readAgentApp = async (name: string): Promise<AgentAppDetail> => decodeDetail(await request(pathOf(name)))

/** A change to an agent app, answered with the app as it is after it. */
export const changeAgentApp = async (name: string, change: AgentAppChange): Promise<AgentAppDetail> =>
  decodeDetail(await request(pathOf(name), { method: 'POST', body: change }))
