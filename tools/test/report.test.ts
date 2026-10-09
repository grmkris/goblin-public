import { describe, expect, test } from 'vitest'
import { verifiedEffectOutput } from '../effect.ts'
import { decodeEffect, fromEffect } from '../report.ts'
import { repoRoot } from '../run.ts'

const summary = { filesChecked: 1, filesWithoutPlugin: 0 }
const at = { line: 4, column: 2, message: 'm' }

describe('effect-tsgo input', () => {
  test('errors and warnings become findings with repository-relative paths; messages and suggestions do not', () => {
    const file = `${repoRoot}/apps/runtime/src/a.ts`
    const output = decodeEffect({
      diagnostics: [
        { ...at, file, severity: 'error', code: 377001, name: 'floatingEffect' },
        { ...at, file, severity: 'warning', code: 377002, name: 'unstableApiUsage' },
        { ...at, file, severity: 'message', code: 377003, name: 'lazyEffect' },
        { ...at, file, severity: 'suggestion', code: 377004, name: 'catchUnfailableEffect' },
      ],
      summary,
    })
    expect(fromEffect(output)).toEqual([
      { source: 'effect', rule: 'effect(floatingEffect)', file: 'apps/runtime/src/a.ts', line: 4, fixable: false },
      { source: 'effect', rule: 'effect(unstableApiUsage)', file: 'apps/runtime/src/a.ts', line: 4, fixable: false },
    ])
  })

  test('a directive that changes nothing gates at any severity, as unusedDirective', () => {
    const file = `${repoRoot}/apps/web/src/a.ts`
    const output = decodeEffect({
      diagnostics: [
        { ...at, file, severity: 'warning', code: 377000, name: 'effect(377000)' },
        { ...at, line: 9, file, severity: 'message', code: 377000, name: 'effect(377000)' },
      ],
      summary,
    })
    expect(fromEffect(output).map((finding) => [finding.rule, finding.line])).toEqual([
      ['effect(unusedDirective)', 4],
      ['effect(unusedDirective)', 9],
    ])
  })
})

describe('directive-shaped strings', () => {
  test('only a directive in a real comment is kept', () => {
    const source = [
      "const fixture = '// @effect-diagnostics-next-line globalDate:off'",
      '// @effect-diagnostics-next-line globalDate:off -- a directive that changes nothing',
      'const n = 1',
      'const text = `// @effect-diagnostics-next-line globalDate:off`',
      'const nested = `${1 /* @effect-diagnostics globalDate:off */}`',
    ].join('\n')
    const file = `${repoRoot}/tools/test/fixture.ts`
    const directive = (line: number, column: number) => ({
      file,
      line,
      column,
      code: 377000,
      severity: 'warning',
      name: 'effect(377000)',
      message: 'm',
    })
    const output = decodeEffect({
      diagnostics: [directive(1, 22), directive(2, 4), directive(4, 20), directive(5, 22)],
      summary,
    })
    const verified = verifiedEffectOutput(output, () => source)
    expect(verified.diagnostics.map((diagnostic) => diagnostic.line)).toEqual([2, 5])
  })

  test('a source that cannot be read or parsed fails the check', () => {
    const output = decodeEffect({
      diagnostics: [{ ...at, file: 'broken.ts', severity: 'warning', code: 377000, name: 'effect(377000)' }],
      summary,
    })
    expect(() =>
      verifiedEffectOutput(output, () => {
        throw new Error('unreadable')
      }),
    ).toThrow('unreadable')
    expect(() => verifiedEffectOutput(output, () => 'const =')).toThrow('cannot parse')
  })
})
