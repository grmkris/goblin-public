import { type Allowed, EVERYTHING, NOTHING, type TopicSetup } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { allows, unallowed } from '../src/setup/catalog.ts'
import { PERSONA_DENIED_TOOLS } from '../src/pi/persona-turn.ts'

const allowed: Allowed = {
  servers: [{ serverId: 'notes', tools: [{ name: 'read' }] }],
  libraries: [{ serverId: 'lib', skills: [{ name: 'review', uri: 'skill://v1/review/SKILL.md' }] }],
  apps: [{ name: 'tracker' }],
}

const outcome = (before: TopicSetup, next: TopicSetup) =>
  unallowed(before, next, allowed).length === 0 ? 'ok' : 'setup_not_allowed'

describe('what the agent may add to a setup (ADR 0040)', () => {
  it('allows what the owner granted or turned on now, and subagents', () => {
    expect(allows(allowed, { kind: 'tool', serverId: 'notes', name: 'read' })).toBe(true)
    expect(allows(allowed, { kind: 'tool', serverId: 'notes', name: 'write' })).toBe(false)
    expect(allows(allowed, { kind: 'skill', serverId: 'lib', name: 'review' })).toBe(true)
    expect(allows(allowed, { kind: 'library', serverId: 'other' })).toBe(false)
    expect(allows(allowed, { kind: 'app', app: 'tracker' })).toBe(true)
    expect(allows(allowed, { kind: 'subagents' })).toBe(true)
  })

  it('refuses a list naming something new the owner does not allow, and keeps what was already there', () => {
    const narrow: TopicSetup = { ...EVERYTHING, mcpServers: [{ serverId: 'gone', tools: 'all' }], apps: [] }
    expect(outcome(narrow, narrow)).toBe('ok')
    expect(outcome(EVERYTHING, narrow)).toBe('ok')
    const added: TopicSetup = { ...narrow, apps: ['tracker', 'diary'] }
    expect(outcome(narrow, added)).toBe('setup_not_allowed')
    expect(outcome({ ...NOTHING, subagents: false }, { ...narrow, mcpServers: 'all' })).toBe('ok')
  })

  it('is never in a Persona fork, which cannot organize', () => {
    expect(PERSONA_DENIED_TOOLS).toContain('topic_setup')
  })
})
