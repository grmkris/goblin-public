import path from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { noCrossBoundaryImport, noRuntimeGlobal } from '../oxlint/boundaries.ts'
import { repoRoot } from '../run.ts'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester()
const at = (file: string): string => path.join(repoRoot, file)

tester.run('no-cross-boundary-import', noCrossBoundaryImport, {
  valid: [
    { code: "import { x } from '@goblin/contracts'", filename: at('apps/runtime/src/agent.ts') },
    { code: "import { env } from 'cloudflare:workers'", filename: at('apps/runtime/src/agent.ts') },
    { code: "import { x } from '@goblin/ui'", filename: at('apps/web/src/route.tsx') },
    { code: "import { x } from '@goblin/runtime/worker'", filename: at('apps/web/src/worker.ts') },
    { code: "import core from '@goblin/app/runtime/core.js?url'", filename: at('apps/web/src/lib/a.ts') },
    { code: "const ui = import('@goblin/app/runtime/ui.css?raw')", filename: at('apps/web/src/lib/a.ts') },
    { code: "import { readFile } from 'node:fs'", filename: at('tools/test/a.test.ts') },
    { code: "import { $ } from 'bun'", filename: at('tools/check.ts') },
  ],
  invalid: [
    {
      code: "import { x } from '@goblin/runtime'",
      filename: at('apps/web/src/route.tsx'),
      errors: [{ messageId: 'workspace' }],
    },
    {
      code: "import { x } from '@goblin/app/toolchain'",
      filename: at('apps/web/src/route.tsx'),
      errors: [{ messageId: 'workspace' }],
    },
    {
      code: "import { readFile } from 'node:fs'",
      filename: at('apps/web/src/route.tsx'),
      errors: [{ messageId: 'runtime' }],
    },
    {
      code: "import { env } from 'cloudflare:workers'",
      filename: at('packages/contracts/src/index.ts'),
      errors: [{ messageId: 'runtime' }],
    },
    {
      code: "import { readFile } from 'node:fs'",
      filename: at('packages/contracts/src/index.ts'),
      errors: [{ messageId: 'runtime' }],
    },
    { code: "import { $ } from 'bun'", filename: at('apps/runtime/src/agent.ts'), errors: [{ messageId: 'runtime' }] },
  ],
})

tester.run('no-runtime-global', noRuntimeGlobal, {
  valid: [{ code: 'const Bun = {}; console.log(Bun)', filename: at('apps/web/src/a.ts') }],
  invalid: [{ code: 'Bun.file("x")', filename: at('apps/runtime/src/agent.ts'), errors: [{ messageId: 'bun' }] }],
})
