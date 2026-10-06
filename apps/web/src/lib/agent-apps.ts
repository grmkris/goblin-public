import { Schema } from 'effect'
import { type AgentAppChange, AgentAppDetail, AgentAppSummary } from '@goblin/contracts'
import { request } from './boundary.ts'

const decodeList = Schema.decodeUnknownSync(Schema.Array(AgentAppSummary))
const decodeDetail = Schema.decodeUnknownSync(AgentAppDetail)
const pathOf = (name: string) => `/api/agent-apps/${encodeURIComponent(name)}`

/** The owner's agent apps, newest change first (ADR 0021). */
export const listAgentApps = async (): Promise<readonly AgentAppSummary[]> =>
  decodeList(await request('/api/agent-apps'))

/** One agent app in full. */
export const readAgentApp = async (name: string): Promise<AgentAppDetail> => decodeDetail(await request(pathOf(name)))

/** A change to an agent app, answered with the app as it is after it. */
export const changeAgentApp = async (name: string, change: AgentAppChange): Promise<AgentAppDetail> =>
  decodeDetail(await request(pathOf(name), { method: 'POST', body: change }))

/** Deletes an agent app; `confirm` is its name, typed by the owner. */
export async function deleteAgentApp(name: string, confirm: string): Promise<void> {
  await request(pathOf(name), { method: 'DELETE', body: { confirm } })
}
