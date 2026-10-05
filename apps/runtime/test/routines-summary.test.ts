import { expect, it } from 'vitest'
import { routineSummary } from '../src/routines/summary.ts'

it('scrubs credentials and control characters before passive reporting and bounds the stored summary', () => {
  const text = routineSummary(
    'Useful result\u0000\u202e\nBearer sample-token\napi_key=sample-key\nwhsec_sample-key\nhttps://owner:sample-password@example.test/path?token=sample-token#fragment',
  )
  expect(text).toContain('Useful result\n')
  expect(text).toContain('https://example.test/path')
  expect(text).not.toContain('sample-')
  expect(text).not.toContain('\u202e')
  expect(routineSummary('x'.repeat(5000))).toHaveLength(1600)
})
