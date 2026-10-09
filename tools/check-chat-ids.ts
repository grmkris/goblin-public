/** Guard logical chat boundaries: application code must not smuggle Pi's root identity back in. */
import { readFileSync } from 'node:fs'
import { chatIdViolations } from './chat-ids.ts'
import { repoRoot } from './run.ts'

const sourceRoot = `${repoRoot}/apps/runtime/src/`
const files = new Bun.Glob('**/*.ts').scanSync({ cwd: sourceRoot, absolute: true })
const failures: string[] = []
for (const file of files) {
  const allowed = { root: file.includes('/chats/'), directory: file.endsWith('/layers/conversation.ts') }
  for (const { line, reason } of chatIdViolations(readFileSync(file, 'utf8'), allowed))
    failures.push(`${file}:${line}: ${reason}`)
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else console.log('chat-id guard passed')
