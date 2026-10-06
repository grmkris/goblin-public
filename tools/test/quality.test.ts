import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { GLOBAL_API_DIAGNOSTICS, effectCheckProjects, severities, stripJsonc, typecheckProjects } from '../effect.ts'
import { placementOf } from '../oxlint/boundaries.ts'
import { nodes } from '../graph.ts'
import { repoRoot } from '../run.ts'

describe('goblin quality tooling', () => {
  test('script parsers preserve explicit project paths', () => {
    expect(typecheckProjects('tsc -p tsconfig.json && tsc -p scripts/tsconfig.json')).toEqual([
      'tsconfig.json',
      'scripts/tsconfig.json',
    ])
    expect(effectCheckProjects('bun tools/effect-check.ts tsconfig.json')).toEqual(['tsconfig.json'])
    expect(JSON.parse(stripJsonc('{"a":"x // text", /* c */ "b":[1,],}'))).toEqual({ a: 'x // text', b: [1] })
  })

  test('runtime zones keep contracts/browser isolated from worker internals', () => {
    expect(placementOf(path.resolve(repoRoot, 'apps/runtime/src/agent.ts'))?.runtime).toBe('cloud')
    expect(placementOf(path.resolve(repoRoot, 'apps/web/src/main.tsx'))?.runtime).toBe('browser')
    expect(placementOf(path.resolve(repoRoot, 'apps/web/test/agent.test.ts'))?.runtime).toBe('test')
    expect(placementOf(path.resolve(repoRoot, 'packages/contracts/src/index.ts'))?.runtime).toBe('shared')
    expect(placementOf(path.resolve(repoRoot, 'bench/src/plan.ts'))?.runtime).toBe('tooling')
    expect(placementOf(path.resolve(repoRoot, 'bench/test/bench.test.ts'))?.runtime).toBe('test')
    expect(nodes.map((node) => node.name)).toEqual([
      '@goblin/bench',
      '@goblin/runtime',
      '@goblin/web',
      '@goblin/contracts',
      '@goblin/ui',
      '@goblin/tools',
    ])
  })

  test('global Effect API diagnostics remain configured', () => {
    expect(GLOBAL_API_DIAGNOSTICS.has('processEnv')).toBe(true)
    expect(GLOBAL_API_DIAGNOSTICS.has('nodeBuiltinImport')).toBe(true)
    expect(severities({ diagnosticSeverity: { processEnv: 'error' } })).toEqual({ processEnv: 'error' })
  })
})
