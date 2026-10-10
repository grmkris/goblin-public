import { Schema } from 'effect'
import { expect } from 'vitest'
import { type NativeCase, probeOf } from './native-case.ts'

const Result = Schema.Struct({
  exclusions: Schema.Unknown,
  invalid: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ _tag: Schema.String, reason: Schema.String }),
  }),
  noInvalidModelWork: Schema.Boolean,
  referenced: Schema.Struct({ ok: Schema.Literal(true) }),
  reference: Schema.Array(Schema.String),
  helperUnchanged: Schema.Boolean,
  tools: Schema.Array(Schema.String),
})

/** Owner submission rejects stale skills before model work and references a helper in the current conversation. */
async function composerChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'composer', Result)
  expect(result.invalid.error).toEqual({
    _tag: 'InvalidInput',
    reason: 'composer:skill:missing:skill://missing/SKILL.md',
  })
  expect(result.noInvalidModelWork).toBe(true)
  expect(result.helperUnchanged).toBe(true)
  expect(result.exclusions).toEqual({
    narrowed: { app: false, skills: false, tool: false, delegation: false },
    restored: { app: true, skills: true, tool: true, delegation: true },
    branched: { app: true, skills: true, tool: true, delegation: true },
    foreignRefused: true,
  })
  const content = result.reference.join('\n')
  expect(content).toContain('Answer here')
  expect(content).toContain('echo: bounded report')
  expect(content).toContain('untrusted')
  expect(result.tools).toEqual(
    expect.arrayContaining([
      'mcp_call',
      'skill_activate',
      'skill_read',
      'files_read',
      'code_run',
      'app_call',
      'subagent_config',
    ]),
  )
  for (const ownerOnly of ['ask_user', 'home_edit', 'routine_propose', 'app_build', 'recall'])
    expect(result.tools).not.toContain(ownerOnly)
}

export const cases: readonly NativeCase[] = [
  {
    title: 'composer rejects stale skills before model work and references a helper in the current conversation',
    run: composerChecks,
  },
]
