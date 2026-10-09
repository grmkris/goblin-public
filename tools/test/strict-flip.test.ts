import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import { describe, expect, test } from 'vitest'
import { repoRoot } from '../run.ts'
import { STRICT_REACT_RULES, STRICT_RULES } from '../strict/index.ts'
import { applyEdits, CONSOLE_ALLOWED, FLIPS } from '../strict-flip.ts'

const flipped = new Map(FLIPS.map(([file, flip]) => [file, flip(readFileSync(path.join(repoRoot, file), 'utf8'))]))
const text = (file: string): string => flipped.get(file) ?? ''

describe('the strict flip on the current tree', () => {
  test('oxlint.config.ts stays valid TypeScript and no longer reads tools/strict', () => {
    const config = text('oxlint.config.ts')
    expect(parseSync('oxlint.config.ts', config).errors).toEqual([])
    expect(config).not.toMatch(/tools\/strict|STRICT_|WEB_DATA_PATHS|satisfies OxlintOverride/u)
  })

  test('every strict rule is on at the top level or for every React file', () => {
    const config = text('oxlint.config.ts')
    for (const rule of [...Object.keys(STRICT_RULES), ...Object.keys(STRICT_REACT_RULES)]) {
      expect(config).toContain(`'${rule}': `)
    }
    expect(config).toContain("'typescript/no-floating-promises': ['error', { ignoreVoid: false }]")
    expect(config).toContain(JSON.stringify(CONSOLE_ALLOWED))
    expect(config).toContain("files: ['apps/web/src/**']")
  })

  test('the Effect and knip switches are on, and the docs describe the flipped set', () => {
    expect(text('tsconfig.base.json')).toContain('"extendsNativeError": "error"')
    expect(text('tsconfig.base.json')).toContain('"catchUnfailableEffect": "error"')
    expect(text('knip.jsonc')).toContain('"treatConfigHintsAsErrors": true')
    expect(text('docs/agents/lint-quality.md')).not.toContain('tools/strict')
    expect(text('docs/agents/lint-quality.md')).toContain('The strict rules are on for every file')
  })
})

describe('applyEdits', () => {
  test('replaces text once, literally', () => {
    expect(applyEdits('f', 'a b c', [{ from: 'b', to: '$&$1' }])).toBe('a $&$1 c')
  })

  test('refuses a missing or repeated anchor', () => {
    expect(() => applyEdits('f', 'a b c', [{ from: 'x', to: 'y' }])).toThrow('found 0')
    expect(() => applyEdits('f', 'a b b', [{ from: 'b', to: 'y' }])).toThrow('found 2')
  })
})
