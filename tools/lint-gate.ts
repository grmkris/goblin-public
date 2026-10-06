/** goblin starts with zero accepted lint/Effect/Knip findings. */
import { collect, SOURCES } from './findings.ts'
const result = await collect(SOURCES)
for (const failure of result.failures) console.error(failure)
for (const finding of result.findings)
  console.error(`${finding.file}:${finding.line}:${finding.source} ${finding.rule}`)
console.info(`lint:gate: ${result.findings.length} findings, ${result.failures.length} collection failures`)
process.exitCode = result.findings.length === 0 && result.failures.length === 0 ? 0 : 1
