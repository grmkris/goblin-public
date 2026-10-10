import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { routinesExtension } from '../src/pi/routines.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { executeTool, inConversation } from './pi-tool.ts'

const DRAFT = {
  id: 'rt_1',
  revision: 1,
  definition: { title: 'Morning brief' },
}
// SAFETY: the propose tool only reads id, revision and the title of the draft its program returns.
const run: RunProgram = <A>() => Promise.resolve(DRAFT as A)
const tools = routinesExtension(run).tools ?? []
const tool = (name: string): ToolRegistration => {
  const found = tools.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`${name} missing`)
  return found
}

const definition = {
  title: 'Morning brief',
  prompt: 'Summarize my calendar.',
  trigger: { kind: 'cron', expression: '0 8 * * *' },
  timezone: 'Europe/Tallinn',
  notifyTelegram: true,
  allowedTools: [{ serverId: 'myplan', name: 'calendar_list' }],
  budget: { tokensPerRun: 20_000, tokensPerDay: 40_000, runtimeSeconds: 120 },
}

describe('routine tools (unit, ADR 0027)', () => {
  it('are one tool per action, each with a schema Pi validates', () => {
    expect(tools.map((candidate) => candidate.name)).toEqual(['routine_propose', 'routine_list', 'routine_pause'])
    const propose = tool('routine_propose')
    expect(
      validateToolArguments(propose, { type: 'toolCall', id: 'c', name: 'routine_propose', arguments: definition }),
    ).toEqual(definition)
    expect(() =>
      validateToolArguments(propose, {
        type: 'toolCall',
        id: 'c',
        name: 'routine_propose',
        arguments: { ...definition, trigger: { kind: 'hourly' } },
      }),
    ).toThrow('Validation failed for tool "routine_propose"')
    expect(() =>
      validateToolArguments(tool('routine_pause'), { type: 'toolCall', id: 'c', name: 'routine_pause', arguments: {} }),
    ).toThrow('Validation failed')
  })

  it('propose a typed definition, end the turn and leave the receipt the web reviews', async () => {
    // The tool reads only the conversation and call ids of its API.
    const result = await executeTool(tool('routine_propose'), definition, inConversation(1, { callId: 'c1' }))
    expect(result).toMatchObject({
      details: {
        kind: 'routine-proposal',
        routineId: 'rt_1',
        revision: 1,
        structuredContent: { routineId: 'rt_1', revision: 1, title: 'Morning brief' },
      },
      control: { terminate: true },
    })
    expect(JSON.stringify(result.content)).toContain('Settings → Routines')
  })
})
