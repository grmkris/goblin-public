import { describe, expect, test } from 'vitest'
import { knipFailures, oxlintFailures } from '../findings.ts'

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

describe('knip collection', () => {
  test('issues alone are findings, not failures', () => {
    expect(knipFailures({ exitCode: 0, stdout: '{"issues":[]}', stderr: '' }, 0)).toEqual([])
    expect(knipFailures({ exitCode: 1, stdout: '{"issues":[]}', stderr: '' }, 3)).toEqual([])
  })

  test('exit 1 with no issue is configuration hints treated as errors, which the JSON report leaves out', () => {
    expect(knipFailures({ exitCode: 1, stdout: '{"issues":[]}', stderr: '' }, 0)).toEqual([
      'knip reported configuration hints, which knip.jsonc treats as errors; `bun run knip` lists them',
    ])
  })

  test('a run that did not finish fails with its stderr', () => {
    expect(knipFailures({ exitCode: 2, stdout: '', stderr: 'boom' }, 0)).toEqual(['knip exited 2\nboom'])
  })
})
