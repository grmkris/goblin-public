import type { DummyRuleMap } from 'oxlint'
import { paths as a } from './a.ts'
import { paths as c } from './c.ts'
import { paths as d } from './d.ts'
import { paths as h } from './h.ts'
import { paths as k } from './k.ts'
import { paths as m } from './m.ts'
import { paths as o } from './o.ts'
import { paths as r } from './r.ts'
import { paths as w1 } from './w1.ts'
import { paths as w2 } from './w2.ts'
import { paths as w3 } from './w3.ts'

/**
 * The strict lint set, ratcheted file by file (docs/agents/lint-quality.md). Each lane appends the globs of files it
 * made pass these rules to its own file in this directory, so no two lanes edit one list; the observability primitives
 * start strict. When every file passes, the rules move to the top level and this directory goes.
 */
const FOUNDATION = ['apps/runtime/src/observability/**']

export const STRICT_PATHS: readonly string[] = [
  ...FOUNDATION,
  ...c,
  ...d,
  ...m,
  ...k,
  ...r,
  ...o,
  ...a,
  ...h,
  ...w1,
  ...w2,
  ...w3,
]

/** Where React runs: the strict hook rules apply to the strict paths among these. */
const REACT_ROOTS = ['apps/web/', 'packages/ui/', 'packages/kit/', 'packages/app/src/ui/']

export const STRICT_REACT_PATHS: readonly string[] = STRICT_PATHS.filter((glob) =>
  REACT_ROOTS.some((root) => glob.startsWith(root)),
)

/** No silent failure, no floating promise, no `any` flowing through. Frozen: lanes add paths, never rules. */
export const STRICT_RULES = {
  'no-console': 'error',
  'no-empty': 'error',
  'prefer-promise-reject-errors': 'error',
  'goblin/no-silent-catch': 'error',
  'typescript/use-unknown-in-catch-callback-variable': 'error',
  'typescript/no-floating-promises': ['error', { ignoreVoid: false }],
  'typescript/no-unsafe-argument': 'error',
  'typescript/no-unsafe-assignment': 'error',
  'typescript/no-unsafe-call': 'error',
  'typescript/no-unsafe-member-access': 'error',
  'typescript/no-unsafe-return': 'error',
} satisfies DummyRuleMap

/** The hook rules, which need the react plugin. */
export const STRICT_REACT_RULES = {
  'react/rules-of-hooks': 'error',
  'react/exhaustive-deps': 'error',
} satisfies DummyRuleMap
