import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  type Allowed,
  EVERYTHING,
  NOTHING,
  PersonaSetup,
  SetupSkill,
  TopicSetup,
  holds,
  itemLabel,
  withItems,
  withoutItems,
} from './index.ts'

const allowed: Allowed = {
  servers: [
    { connectionId: 'notes', tools: [{ name: 'read' }, { name: 'write' }] },
    { connectionId: 'mail', tools: [{ name: 'send' }] },
  ],
  libraries: [
    {
      connectionId: 'lib',
      skills: [
        { name: 'review', uri: 'skill://v1/review/SKILL.md' },
        { name: 'plan', uri: 'skill://v1/plan/SKILL.md' },
      ],
    },
  ],
  apps: [{ name: 'tracker' }, { name: 'diary' }],
}

describe('a setup', () => {
  it('holds everything when every category is all, including what the owner allows later', () => {
    expect(holds(EVERYTHING, { kind: 'tool', connectionId: 'later', name: 'x' })).toBe(true)
    expect(holds(EVERYTHING, { kind: 'skill', connectionId: 'later', name: 'x' })).toBe(true)
    expect(holds(EVERYTHING, { kind: 'subagents' })).toBe(true)
  })

  it('holds only what its lists name, and nothing granted later', () => {
    const setup: TopicSetup = {
      mcpServers: [{ connectionId: 'notes', tools: ['read'] }],
      skills: [{ connectionId: 'lib', name: 'review' }],
      apps: ['tracker'],
      subagents: false,
    }
    expect(holds(setup, { kind: 'server', connectionId: 'notes' })).toBe(true)
    expect(holds(setup, { kind: 'tool', connectionId: 'notes', name: 'read' })).toBe(true)
    expect(holds(setup, { kind: 'tool', connectionId: 'notes', name: 'write' })).toBe(false)
    expect(holds(setup, { kind: 'server', connectionId: 'mail' })).toBe(false)
    expect(holds(setup, { kind: 'library', connectionId: 'lib' })).toBe(true)
    expect(holds(setup, { kind: 'skill', connectionId: 'lib', name: 'plan' })).toBe(false)
    expect(holds(setup, { kind: 'app', app: 'diary' })).toBe(false)
    expect(holds(setup, { kind: 'subagents' })).toBe(false)
  })

  it('keeps a skill chosen by name when a new version changes its URI, and a kept URI tells namesakes apart', () => {
    const byName: TopicSetup = { ...EVERYTHING, skills: [{ connectionId: 'lib', name: 'review' }] }
    expect(
      holds(byName, { kind: 'skill', connectionId: 'lib', name: 'review', uri: 'skill://v2/review/SKILL.md' }),
    ).toBe(true)
    const pinned: TopicSetup = { ...EVERYTHING, skills: [{ connectionId: 'lib', name: 'review', uri: 'skill://a' }] }
    expect(holds(pinned, { kind: 'skill', connectionId: 'lib', name: 'review', uri: 'skill://a' })).toBe(true)
    expect(holds(pinned, { kind: 'skill', connectionId: 'lib', name: 'review', uri: 'skill://b' })).toBe(false)
  })

  it('never lets a Persona hold subagents', () => {
    expect(holds({ ...NOTHING, mcpServers: 'all' }, { kind: 'subagents' })).toBe(false)
  })

  it('adds items without duplicates, a whole server or library taking the place of its parts', () => {
    const added = withItems(NOTHING, [
      { kind: 'tool', connectionId: 'notes', name: 'read' },
      { kind: 'tool', connectionId: 'notes', name: 'read' },
      { kind: 'skill', connectionId: 'lib', name: 'plan' },
      { kind: 'app', app: 'tracker' },
    ])
    expect(added).toEqual({
      mcpServers: [{ connectionId: 'notes', tools: ['read'] }],
      skills: [{ connectionId: 'lib', name: 'plan' }],
      apps: ['tracker'],
    })
    expect(
      withItems(added, [
        { kind: 'server', connectionId: 'notes' },
        { kind: 'library', connectionId: 'lib' },
      ]),
    ).toEqual({
      mcpServers: [{ connectionId: 'notes', tools: 'all' }],
      skills: [{ connectionId: 'lib' }],
      apps: ['tracker'],
    })
    expect(withItems(EVERYTHING, [{ kind: 'server', connectionId: 'notes' }])).toBe(EVERYTHING)
  })

  it('narrows a category that held everything to what is allowed now, less the item', () => {
    const narrowed = withoutItems(
      EVERYTHING,
      [
        { kind: 'tool', connectionId: 'notes', name: 'write' },
        { kind: 'server', connectionId: 'mail' },
        { kind: 'skill', connectionId: 'lib', name: 'plan' },
        { kind: 'app', app: 'diary' },
        { kind: 'subagents' },
      ],
      allowed,
    )
    expect(narrowed).toEqual({
      mcpServers: [{ connectionId: 'notes', tools: ['read'] }],
      skills: [{ connectionId: 'lib', name: 'review' }],
      apps: ['tracker'],
      subagents: false,
    })
  })

  it('decodes only well-formed setups', () => {
    expect(Schema.is(TopicSetup)(EVERYTHING)).toBe(true)
    expect(Schema.is(PersonaSetup)(NOTHING)).toBe(true)
    expect(Schema.is(TopicSetup)({ ...EVERYTHING, apps: ['Bad Name'] })).toBe(false)
    expect(Schema.is(SetupSkill)({ connectionId: 'lib', uri: 'skill://x' })).toBe(false)
  })

  it('reads items as the owner and the model see them', () => {
    expect(itemLabel({ kind: 'tool', connectionId: 'notes', name: 'read' })).toBe('notes · read')
    expect(itemLabel({ kind: 'library', connectionId: 'lib' })).toBe('skills from lib')
  })
})
