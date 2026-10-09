import { describe, expect, test } from 'vitest'
import { oxlintFailures } from '../findings.ts'

describe('oxlint collection', () => {
  test('a clean run, with or without findings, is complete', () => {
    expect(oxlintFailures({ exitCode: 0, stdout: '{"diagnostics":[]}', stderr: '' })).toEqual([])
    expect(oxlintFailures({ exitCode: 1, stdout: '{"diagnostics":[]}', stderr: '  \n' })).toEqual([])
  })

  test('anything on stderr fails the gate, even when oxlint exits 0 or 1', () => {
    const stderr = 'Failed to load JS plugin: ./tools/oxlint/goblin.ts'
    expect(oxlintFailures({ exitCode: 0, stdout: '{"diagnostics":[]}', stderr })).toEqual([
      `oxlint wrote to stderr\n${stderr}`,
    ])
    expect(oxlintFailures({ exitCode: 1, stdout: '{"diagnostics":[]}', stderr })).toHaveLength(1)
  })

  test('a run that did not finish fails once, with its stderr', () => {
    expect(oxlintFailures({ exitCode: 2, stdout: '', stderr: 'panic' })).toEqual(['oxlint exited 2\npanic'])
  })
})
