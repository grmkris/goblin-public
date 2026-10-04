/** Validate portable documentation without the private agent configuration. */
import { checkDocs } from './docs.ts'
import { listFiles } from './agents.ts'
import { repoRoot } from './run.ts'

const failures = checkDocs(repoRoot, listFiles(repoRoot))
for (const failure of failures) console.error(failure)
if (failures.length > 0) process.exitCode = 1
else console.info('public docs passed')
