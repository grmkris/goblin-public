import { describe, expect, it } from 'vitest'
import { EVERYTHING, NOTHING, type SetupCatalog, type TopicSetup } from '@goblin/contracts'
import {
  everything,
  heldCount,
  libraryHold,
  onlyThese,
  serverHold,
  setupSummary,
  switched,
  unavailableIn,
} from '../src/lib/setup.ts'

const catalog: SetupCatalog = {
  servers: [
    { connectionId: 'notes', label: 'Notes', status: 'connected', tools: [{ name: 'read' }, { name: 'write' }] },
    { connectionId: 'mail', label: 'Mail', status: 'connected', tools: [{ name: 'send' }] },
  ],
  libraries: [
    {
      connectionId: 'lib',
      label: 'Skills',
      available: true,
      skills: [
        { name: 'review', uri: 'skill://v1/review/SKILL.md', description: 'Review' },
        { name: 'plan', uri: 'skill://v1/plan/SKILL.md', description: 'Plan' },
      ],
    },
  ],
  apps: [{ name: 'tracker', title: 'Tracker' }],
}

describe('the setup picker (ADR 0040)', () => {
  it('switches a category to only what is there now, so nothing vanishes, and back to everything', () => {
    const only = onlyThese(EVERYTHING, 'mcpServers', catalog)
    expect(only.mcpServers).toEqual([
      { connectionId: 'notes', tools: 'all' },
      { connectionId: 'mail', tools: 'all' },
    ])
    expect(onlyThese(only, 'mcpServers', catalog)).toBe(only)
    expect(everything(only, 'mcpServers')).toEqual(EVERYTHING)
  })

  it('reads a server as all, some or none of its tools, and a library as whole, some or none', () => {
    const one = switched(
      onlyThese(EVERYTHING, 'mcpServers', catalog),
      { kind: 'tool', connectionId: 'notes', name: 'write' },
      false,
      catalog,
    )
    const [notes, mail] = catalog.servers
    if (notes === undefined || mail === undefined) throw new Error('catalog')
    expect(serverHold(one, notes)).toBe('some')
    expect(serverHold(one, mail)).toBe('all')
    expect(serverHold(switched(one, { kind: 'server', connectionId: 'mail' }, false, catalog), mail)).toBe('none')
    const [lib] = catalog.libraries
    if (lib === undefined) throw new Error('catalog')
    const skills = switched(
      onlyThese(EVERYTHING, 'skills', catalog),
      { kind: 'skill', connectionId: 'lib', name: 'plan' },
      false,
      catalog,
    )
    expect(libraryHold(skills, lib)).toBe('some')
    expect(libraryHold(EVERYTHING, lib)).toBe('all')
    expect(libraryHold({ ...EVERYTHING, skills: [] }, lib)).toBe('none')
  })

  it('lists what the setup holds that cannot be chosen now, with why', () => {
    const setup: TopicSetup = {
      mcpServers: [
        { connectionId: 'gone', tools: 'all' },
        { connectionId: 'notes', tools: ['read', 'delete'] },
      ],
      skills: [{ connectionId: 'lib', name: 'old' }, { connectionId: 'off' }],
      apps: ['tracker', 'diary'],
      subagents: true,
    }
    expect(unavailableIn(setup, catalog).map(({ label, reason }) => `${label}: ${reason}`)).toEqual([
      'gone: Not connected, or no tool granted',
      'notes · delete: Not granted any more',
      'lib · old: No longer listed',
      'skills from off: Skills are off for this server',
      'app diary: No longer there',
    ])
  })

  it('says a setup in a line, for the composer and a Persona', () => {
    expect(setupSummary(EVERYTHING, catalog)).toBe('Everything')
    const narrow: TopicSetup = {
      mcpServers: [{ connectionId: 'notes', tools: ['read'] }],
      skills: [{ connectionId: 'lib' }],
      apps: [],
      subagents: false,
    }
    expect(setupSummary(narrow, catalog)).toBe('1 MCP server · 2 skills · no apps')
    expect(setupSummary({ ...narrow, skills: 'all' }, catalog)).toBe('1 MCP server · all skills · no apps')
    expect(heldCount(NOTHING, 'apps', catalog)).toBe(0)
  })
})
