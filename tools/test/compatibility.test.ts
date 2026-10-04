import { expect, test } from 'vitest'
import { verifyEvidenceText, verifyMcpTable } from '../compatibility-check.ts'

test('documentation fails on an undeclared root command', () => {
  expect(verifyEvidenceText('Use `bun run invented:gate`.', new Set(['check']))).toEqual([
    'unknown documented root command: invented:gate',
  ])
  expect(verifyEvidenceText('Use `bun run check`.', new Set(['check']))).toEqual([])
})
test('a nonempty compatibility document still fails when its matrix omits evidence', () => {
  const failures = verifyMcpTable('| Feature | Implementation |\n| --- | --- |\n| tools/list | implemented |')
  expect(failures).toContain('MCP table missing column: evidence')
  expect(failures).toContain('MCP table missing feature: MyPlan real endpoint')
})
