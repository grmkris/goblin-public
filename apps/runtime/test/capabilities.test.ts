import type { Tool } from '@modelcontextprotocol/client'
import type { ServerView } from '@purrable/contracts'
import { describe, expect, it } from 'vitest'
import { type Exclusion, sameExclusions, scopeOf } from '../src/capabilities/profiles.ts'
import { memberScope } from '../src/capabilities/member.ts'
import { capabilityView, offers } from '../src/capabilities/view.ts'

const off = (kind: Exclusion['kind'], serverId = '', name = ''): Exclusion => ({ kind, serverId, name })

const server = (serverId: string, extra: Partial<ServerView> = {}): ServerView => ({
  serverId,
  endpoint: `https://${serverId}.test/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  ...extra,
})

const tool = (name: string, visibility?: readonly string[]): Tool => ({
  name,
  inputSchema: { type: 'object' },
  ...(visibility === undefined ? {} : { _meta: { ui: { visibility } } }),
})

describe('what a conversation switched off', () => {
  it('leaves everything on that it did not switch off, including tools granted later', () => {
    const scope = scopeOf([], true)
    expect([
      scope.server('myplan'),
      scope.tool('myplan', 'new_tool'),
      scope.skills('myskills'),
      scope.subagents(),
    ]).toEqual([true, true, true, true])
  })
  it('turns off a server with every tool under it, and a single tool alone', () => {
    const scope = scopeOf([off('server', 'mybrowser'), off('tool', 'myplan', 'delete')], true)
    expect(scope.server('mybrowser')).toBe(false)
    expect(scope.tool('mybrowser', 'open')).toBe(false)
    expect(scope.tool('myplan', 'delete')).toBe(false)
    expect(scope.tool('myplan', 'read')).toBe(true)
    expect(scope.server('myplan')).toBe(true)
  })
  it('keeps skills and subagents apart from the servers', () => {
    const scope = scopeOf([off('skills', 'myskills'), off('subagents')], false)
    expect(scope.skills('myskills')).toBe(false)
    expect(scope.server('myskills')).toBe(true)
    expect(scope.subagents()).toBe(false)
    expect(scope.editable).toBe(false)
  })
  it('compares two conversations by what they switched off, in any order', () => {
    expect(sameExclusions([off('subagents'), off('server', 'a')], [off('server', 'a'), off('subagents')])).toBe(true)
    expect(sameExclusions([off('server', 'a')], [off('server', 'a'), off('subagents')])).toBe(false)
    expect(sameExclusions([], [])).toBe(true)
  })
})

describe("a conversation's switches as the owner sees them", () => {
  const input = {
    thread: '7',
    kind: 'thread' as const,
    servers: [server('myplan', { title: 'MyPlan' }), server('mybrowser', { serverName: 'MyTab' }), server('idle')],
    grants: [
      { serverId: 'myplan', capability: 'tool' as const, name: 'read' },
      { serverId: 'myplan', capability: 'tool' as const, name: 'app_only' },
      { serverId: 'myplan', capability: 'resource' as const, name: 'ui://myplan/app.html' },
      { serverId: 'mybrowser', capability: 'tool' as const, name: 'open' },
    ],
    listed: (serverId: string) => (serverId === 'myplan' ? [tool('read'), tool('app_only', ['app'])] : undefined),
    skillSources: ['myplan'],
    own: [off('tool', 'mybrowser', 'open'), off('skills', 'myplan')],
    inherited: [off('skills', 'myplan')],
  }
  it('lists servers with a granted tool, and only the tools the agent can call', () => {
    const view = capabilityView(input)
    expect(view.servers).toEqual([
      { serverId: 'myplan', label: 'MyPlan', status: 'connected', on: true, tools: [{ name: 'read', on: true }] },
      { serverId: 'mybrowser', label: 'MyTab', status: 'connected', on: true, tools: [{ name: 'open', on: false }] },
    ])
    expect(view.skills).toEqual([{ serverId: 'myplan', label: 'MyPlan', on: false }])
    expect(view.subagents).toBe(true)
    expect(view.sameAsParent).toBe(false)
  })
  it("says whether a thread has its parent's switches, and says nothing about it for main", () => {
    expect(capabilityView({ ...input, own: input.inherited }).sameAsParent).toBe(true)
    expect(capabilityView({ ...input, kind: 'main', thread: '1' })).not.toHaveProperty('sameAsParent')
  })
  it('offers to switch only what it shows', () => {
    const view = capabilityView(input)
    expect(offers(view, { kind: 'tool', serverId: 'myplan', name: 'read' })).toBe(true)
    expect(offers(view, { kind: 'tool', serverId: 'myplan', name: 'app_only' })).toBe(false)
    expect(offers(view, { kind: 'server', serverId: 'idle' })).toBe(false)
    expect(offers(view, { kind: 'skills', serverId: 'myplan' })).toBe(true)
    expect(offers(view, { kind: 'skills', serverId: 'mybrowser' })).toBe(false)
    expect(offers(view, { kind: 'subagents' })).toBe(true)
  })
})

describe('member ceiling inside the conversation scope', () => {
  const bound = {
    role: 'member' as const,
    policy: {
      servers: [
        { serverId: 'myplan', endpoint: 'https://myplan.test/mcp', tools: ['read', 'delete'] },
        { serverId: 'telegram', endpoint: 'https://telegram.test/mcp', tools: ['send_message'] },
      ],
      skills: [{ serverId: 'myskills', endpoint: 'https://myskills.test/mcp' }],
      mainHistory: 'own' as const,
    },
    endpoint: (id: string) => `https://${id}.test/mcp`,
    telegramServer: 'telegram',
  }
  it('never widens exclusions, later grants, skills, or subagent switches', () => {
    const scope = memberScope(scopeOf([off('tool', 'myplan', 'delete'), off('subagents')], true), bound)
    expect(scope.tool('myplan', 'read')).toBe(true)
    expect(scope.tool('myplan', 'delete')).toBe(false)
    expect(scope.tool('myplan', 'later_grant')).toBe(false)
    expect(scope.server('other')).toBe(false)
    expect(scope.skills('myskills')).toBe(true)
    expect(scope.skills('other')).toBe(false)
    expect(scope.subagents()).toBe(false)
    expect(scope.editable).toBe(false)
  })
  it('fences endpoint replacement and keeps Telegram owner-only even when invited', () => {
    const scope = memberScope(scopeOf([], true), { ...bound, endpoint: () => 'https://replacement.test/mcp' })
    expect(scope.server('myplan')).toBe(false)
    expect(scope.skills('myskills')).toBe(false)
    expect(memberScope(scopeOf([], true), bound).tool('telegram', 'send_message')).toBe(false)
  })
  it('viewers have no execution authority', () => {
    const scope = memberScope(scopeOf([], true), { ...bound, role: 'viewer' })
    expect([scope.server('myplan'), scope.tool('myplan', 'read'), scope.skills('myskills'), scope.subagents()]).toEqual(
      [false, false, false, false],
    )
  })
})
