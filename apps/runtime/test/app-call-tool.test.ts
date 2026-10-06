import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import type { CallRequest, CallResult } from '../src/agent-apps/dispatch.ts'
import { AppToolset } from '../src/agent-apps/toolset.ts'

const calls: CallRequest[] = []
const dispatch = {
  active: () => 'r_1',
  manifest: () => ({ actions: { add: { agent: true }, reset: { agent: false } } }),
  call: async (request: CallRequest): Promise<CallResult> => {
    calls.push(request)
    return request.member === 'dump'
      ? { kind: 'view', revision: 4, value: Array.from({ length: 2_000 }, (_, index) => ({ index })) }
      : { kind: 'action', revision: 2, state: { count: 3 } }
  },
}
const tools = new AppToolset({ powers: () => [] }, dispatch).extensions()[0]?.tools ?? []
const tool: ToolRegistration | undefined = tools[0]
if (tool === undefined) throw new Error('app_call missing')

type Arguments = Parameters<typeof validateToolArguments>[1]['arguments']

const run = (args: Arguments) => {
  const checked = validateToolArguments(tool, { type: 'toolCall', id: 'tc_1', name: 'app_call', arguments: args })
  // SAFETY: app_call reads the conversation, the call id and the release memo of the API, and none of the context.
  return tool.execute(
    checked,
    { conversationId: 7, callId: 'tc_1', memo: async (_k: string, v: unknown) => v } as never,
    {} as never,
  )
}

describe('app_call (unit, ADR 0027)', () => {
  it('takes the input as an object or as the JSON string models often send', async () => {
    for (const input of [{ by: 3 }, '{"by": 3}']) {
      const result = await run({ app: 'counter', member: 'add', input })
      expect(result.isError).toBeUndefined()
      expect(result.details).toMatchObject({ structuredContent: { revision: 2, state: { count: 3 } } })
      expect(calls.at(-1)).toMatchObject({ app: 'counter', member: 'add', input: { by: 3 }, op: 'c7:tc_1' })
    }
    const wrong = await run({ app: 'counter', member: 'add', input: 3 })
    expect(wrong.isError).toBe(true)
    expect(JSON.stringify(wrong.content)).toContain("The arguments do not match app_call's input")
  })

  it("refuses an action for the owner's view only, and summarizes a result too large to show", async () => {
    const refused = await run({ app: 'counter', member: 'reset' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain("for the owner's view only")
    const large = await run({ app: 'counter', member: 'dump' })
    expect(large.details).toMatchObject({ structuredContent: { revision: 4, truncated: { keys: [], items: 2_000 } } })
  })
})
