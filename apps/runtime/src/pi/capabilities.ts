import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { type CapabilityTarget, type NotInTopic, type SetupItem, itemLabel } from '@goblin/contracts'
import type { CapabilityScope, ScopeTopic } from '../capabilities/profiles.ts'

/** How a target reads in a tool result: the server, the server's tool, its skills, or subagents. */
const named = (target: CapabilityTarget): string => {
  if (target.kind === 'subagents') return 'subagents'
  if (target.kind === 'skills') return `skills from ${target.serverId}`
  return target.kind === 'tool' ? `${target.serverId} · ${target.name}` : target.serverId
}

/** The setup item a switch target names: a skills switch is a library. */
const itemOf = (target: CapabilityTarget): SetupItem =>
  target.kind === 'skills' ? { ...target, kind: 'library' } : target

/**
 * What the model gets when its Topic's setup does not hold what it asked for (ADR 0040): nothing ran. Where the owner
 * talks with it (a Conversation or a thread) the details carry `kind: 'not-in-topic'`, the item and the Topic, which the
 * web turns into an owner-only "Add to #Topic" card, and it waits for them; a subagent, a Persona or a routine gets
 * words only. Like `grantRequiredResult`, the marker is a top-level `kind` remote results never have.
 */
function notInTopicResult(item: SetupItem, topic: ScopeTopic, editable: boolean): ToolExecutionResult {
  const what = itemLabel(item)
  const diagnostics = [{ severity: 'info', code: 'not_in_topic', message: 'Not in the Topic setup.' }] as const
  if (!editable)
    return {
      content: [
        {
          type: 'text',
          text: `Not in #${topic.name}'s setup: ${what}. Nothing ran. Say in your answer that you could not use it.`,
        },
      ],
      isError: true,
      diagnostics: [...diagnostics],
    }
  const details: NotInTopic = { kind: 'not-in-topic', target: item, topic: { id: topic.id, name: topic.name } }
  return {
    content: [
      {
        type: 'text',
        text: `Not in #${topic.name}'s setup: ${what}. Nothing ran. The owner has been shown a button to add it to #${topic.name}. Stop here and wait for their reply. Do not add it to the setup yourself unless the owner asks you to.`,
      },
    ],
    isError: true,
    diagnostics: [...diagnostics],
    details,
  }
}

/**
 * What the model gets for something it may not use here: when its Topic's setup does not hold it, a refusal that names
 * the Topic (above); otherwise something the conversation that started a subagent switched off for it, or a routine's
 * allowed tools leave out: nothing ran, and it says so in its answer.
 */
export function capabilityOffResult(target: CapabilityTarget, scope: CapabilityScope): ToolExecutionResult {
  const item = itemOf(target)
  if (scope.topic !== undefined && !scope.topic.holds(item)) return notInTopicResult(item, scope.topic, scope.editable)
  return {
    content: [
      {
        type: 'text',
        text: `Off for the conversation that started you: ${named(target)}. Nothing ran. Say in your answer that you could not use it.`,
      },
    ],
    isError: true,
    diagnostics: [{ severity: 'info', code: 'capability_off', message: 'Capability disabled in this conversation.' }],
  }
}

/** What of an MCP server and tool is switched off in `scope`: the server first, then the tool; none when both are on. */
export function mcpOff(scope: CapabilityScope, serverId: string, name: string): CapabilityTarget | undefined {
  if (!scope.server(serverId)) return { kind: 'server', serverId }
  return scope.tool(serverId, name) ? undefined : { kind: 'tool', serverId, name }
}
