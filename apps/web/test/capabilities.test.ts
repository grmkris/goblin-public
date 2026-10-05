import type { ConversationCapabilities } from '@purrable/contracts'
import { describe, expect, it } from 'vitest'
import { applyChange, capabilityCount, serverState, targetLabel } from '../src/lib/capabilities.ts'

const view: ConversationCapabilities = {
  thread: '7',
  kind: 'thread',
  servers: [
    {
      serverId: 'myplan',
      label: 'MyPlan',
      status: 'connected',
      on: true,
      tools: [
        { name: 'read', on: true },
        { name: 'delete', on: false },
      ],
    },
    { serverId: 'mybrowser', label: 'MyTab', status: 'connected', on: false, tools: [{ name: 'open', on: true }] },
  ],
  skills: [{ serverId: 'myskills', label: 'MySkills', on: true }],
  subagents: true,
  sameAsMain: false,
}

describe('what a conversation lets its agent use, as the composer shows it', () => {
  it('counts each tool (off under a server switched off), each library and subagents', () => {
    expect(capabilityCount(view)).toEqual({ on: 3, total: 5 })
    const everything = applyChange(applyChange(view, { target: { kind: 'server', serverId: 'mybrowser' }, on: true }), {
      target: { kind: 'tool', serverId: 'myplan', name: 'delete' },
      on: true,
    })
    expect(capabilityCount(everything)).toEqual({ on: 5, total: 5 })
  })
  it('shows a server on, off, or on with some of its tools off', () => {
    const [myplan, mybrowser] = view.servers
    expect(myplan && serverState(myplan)).toBe('some')
    expect(mybrowser && serverState(mybrowser)).toBe('off')
    expect(serverState({ ...view.servers[0]!, tools: [{ name: 'read', on: true }] })).toBe('on')
  })
  it("shows a change at once, forgetting whether the thread still has main's setup, and leaves a reset to the agent", () => {
    const changed = applyChange(view, { target: { kind: 'skills', serverId: 'myskills' }, on: false })
    expect(changed.skills).toEqual([{ serverId: 'myskills', label: 'MySkills', on: false }])
    expect(changed).not.toHaveProperty('sameAsMain')
    expect(applyChange(view, { target: { kind: 'subagents' }, on: false }).subagents).toBe(false)
    expect(applyChange(view, { reset: 'main' })).toBe(view)
  })
  it("names a target after its server's label, or its id when the view does not have it", () => {
    expect(targetLabel({ kind: 'server', serverId: 'mybrowser' }, view)).toBe('MyTab')
    expect(targetLabel({ kind: 'tool', serverId: 'myplan', name: 'delete' }, view)).toBe('MyPlan · delete')
    expect(targetLabel({ kind: 'skills', serverId: 'myskills' }, view)).toBe('Skills from MySkills')
    expect(targetLabel({ kind: 'server', serverId: 'unknown' })).toBe('unknown')
    expect(targetLabel({ kind: 'subagents' })).toBe('Subagents')
  })
})
