import { describe, expect, it } from 'vitest'
import { type Exclusion, scopeOf } from '../src/setup/scope.ts'

const off = (kind: Exclusion['kind'], connectionId = '', name = ''): Exclusion => ({ kind, connectionId, name })

describe("what a spawner switched off for its subagent (ADR 0018's exclusions)", () => {
  it('leaves everything on that it did not switch off, including tools granted later', () => {
    const scope = scopeOf([], true)
    expect([
      scope.server('myplan'),
      scope.tool('myplan', 'new_tool'),
      scope.skills('myskills'),
      scope.subagents(),
      scope.app('counter'),
    ]).toEqual([true, true, true, true, true])
  })
  it('turns off a server with every tool under it, and a single tool alone', () => {
    const scope = scopeOf([off('server', 'mybrowser'), off('tool', 'myplan', 'delete')], true)
    expect(scope.server('mybrowser')).toBe(false)
    expect(scope.tool('mybrowser', 'open')).toBe(false)
    expect(scope.tool('myplan', 'delete')).toBe(false)
    expect(scope.tool('myplan', 'read')).toBe(true)
    expect(scope.server('myplan')).toBe(true)
  })
  it('keeps skills, subagents and apps apart from the servers', () => {
    const scope = scopeOf([off('skills', 'myskills'), off('subagents')], false, new Set(['counter']))
    expect(scope.skills('myskills')).toBe(false)
    expect(scope.server('myskills')).toBe(true)
    expect(scope.subagents()).toBe(false)
    expect(scope.app('counter')).toBe(false)
    expect(scope.app('diary')).toBe(true)
    expect(scope.editable).toBe(false)
  })
})
