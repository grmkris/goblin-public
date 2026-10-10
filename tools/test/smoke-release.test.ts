import { describe, expect, it } from 'vitest'
import { pointsOf, sendPointsQuery } from '../../scripts/smoke-release.ts'

describe('the flows check', () => {
  it("counts the stage's own send points in its dataset, over whole minutes", () => {
    expect(sendPointsQuery('dev', 2.2)).toBe(
      [
        'SELECT SUM(_sample_interval) AS points',
        'FROM "goblin-dev-flows"',
        "WHERE timestamp > NOW() - INTERVAL '3' MINUTE",
        "  AND blob1 = 'send' AND blob7 = 'dev'",
        'FORMAT JSON',
      ].join('\n'),
    )
    expect(sendPointsQuery('prod', 0)).toContain("INTERVAL '1' MINUTE")
  })

  it('names only a known stage', () => {
    expect(() => sendPointsQuery("dev' OR '1'='1", 1)).toThrow('unsupported_stage')
  })

  it("reads Analytics Engine's answer, whether it counts as a number, a string or nothing", () => {
    expect(pointsOf({ data: [{ points: 2 }], meta: [] })).toBe(2)
    expect(pointsOf({ data: [{ points: '3' }] })).toBe(3)
    expect(pointsOf({ data: [{ points: null }] })).toBe(0)
    expect(pointsOf({ data: [] })).toBe(0)
    expect(() => pointsOf({ errors: [] })).toThrow()
  })
})
