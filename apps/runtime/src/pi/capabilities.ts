import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { CapabilityTarget } from '@goblin/contracts'
import type { CapabilityScope } from '../capabilities/profiles.ts'

/** How a target reads in a tool result: the server, the server's tool, its skills, or subagents. */
const named = (target: CapabilityTarget): string => {
  if (target.kind === 'subagents') return 'subagents'
  if (target.kind === 'skills') return `skills from ${target.serverId}`
  return target.kind === 'tool' ? `${target.serverId} · ${target.name}` : target.serverId
}

/**
 * What the model gets for something switched off in its conversation: nothing ran, and it waits for the owner. In a
 * conversation the owner can switch (main or a thread) the details carry `kind: 'capability-off'` and the target,
 * which the web turns into an owner-only "Turn on here" card; like `grantRequiredResult`, the marker is a top-level
 * `kind` remote results never have. A subagent follows the conversations above it, so it gets words only.
 */
export function capabilityOffResult(target: CapabilityTarget, scope: CapabilityScope): ToolExecutionResult {
  const what = named(target)
  if (!scope.editable)
    return {
      content: [
        {
          type: 'text',
          text: `Off for the conversation that started you: ${what}. Nothing ran. Say in your answer that you could not use it.`,
        },
      ],
      isError: true,
    }
  return {
    content: [
      {
        type: 'text',
        text: `Off in this conversation: ${what}. Nothing ran. The owner has been shown a button to turn it on here. Stop here and wait for their reply.`,
      },
    ],
    isError: true,
    details: { kind: 'capability-off', target },
  }
}

/** What of an MCP server and tool is switched off in `scope`: the server first, then the tool; none when both are on. */
export function mcpOff(scope: CapabilityScope, serverId: string, name: string): CapabilityTarget | undefined {
  if (!scope.server(serverId)) return { kind: 'server', serverId }
  return scope.tool(serverId, name) ? undefined : { kind: 'tool', serverId, name }
}
