import path from 'node:path'
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { noClosedImport, noCrossBoundaryImport, noRuntimeGlobal } from '../oxlint/boundaries.ts'
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
    { code: "import { InternalApi } from '@goblin/contracts/internal'", filename: at('apps/runtime/src/worker.ts') },
    { code: "import { x } from '@goblin/contracts/internals'", filename: at('apps/web/src/lib/a.ts') },
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
    {
      code: "import type { InternalApi } from '@goblin/contracts/internal'",
      filename: at('apps/web/src/lib/a.ts'),
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: "export * from '@goblin/contracts/internal/ask'",
      filename: at('apps/web/src/worker.ts'),
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: "const api = import('@goblin/contracts/internal')",
      filename: at('apps/web/test/a.test.ts'),
      errors: [{ messageId: 'forbidden' }],
    },
  ],
})

tester.run('no-closed-import', noClosedImport, {
  valid: [
    { code: "import { makeBridge } from './runtime/bridge.ts'", filename: at('apps/runtime/src/agent.ts') },
    { code: "import type { RunProgram } from '../runtime/bridge.ts'", filename: at('apps/runtime/src/pi/thread.ts') },
    { code: "import type { RunProgram } from '../src/runtime/bridge.ts'", filename: at('apps/runtime/test/a.test.ts') },
    { code: "import { promiseWith } from '../runtime/boundary.ts'", filename: at('apps/runtime/src/mcp/auth.ts') },
    // Only promiseWith is closed in boundary.ts.
    {
      code: "import { bound } from '../runtime/boundary.ts'",
      filename: at('apps/runtime/src/mcp/approval-decision.ts'),
    },
    // Another module of the same name elsewhere is not the bridge.
    { code: "import { x } from './bridge.ts'", filename: at('apps/runtime/src/chats/a.ts') },
  ],
  invalid: [
    {
      code: "import type { RunProgram } from '../runtime/bridge.ts'",
      filename: at('apps/runtime/src/chats/operations.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "import { makeBridge } from './bridge.ts'",
      filename: at('apps/runtime/src/runtime/changes.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "export { makeBridge } from '../../runtime/bridge.ts'",
      filename: at('apps/runtime/src/chats/conversations/core.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "const bridge = import('../runtime/bridge.ts')",
      filename: at('apps/runtime/src/layers/core.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "import { bound, promiseWith } from '../runtime/boundary.ts'",
      filename: at('apps/runtime/src/chats/operations.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "import * as boundary from '../runtime/boundary.ts'",
      filename: at('apps/runtime/src/layers/mcp.ts'),
      errors: [{ messageId: 'closed' }],
    },
    {
      code: "export * from '../../apps/runtime/src/runtime/boundary.ts'",
      filename: at('bench/src/a.ts'),
      errors: [{ messageId: 'closed' }],
    },
  ],
})

tester.run('no-runtime-global', noRuntimeGlobal, {
  valid: [{ code: 'const Bun = {}; console.log(Bun)', filename: at('apps/web/src/a.ts') }],
  invalid: [{ code: 'Bun.file("x")', filename: at('apps/runtime/src/agent.ts'), errors: [{ messageId: 'bun' }] }],
})
