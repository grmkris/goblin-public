import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { ApiError, FilePath } from './index.ts'

describe('contracts', () => {
  it('decodes the public error body and ignores unknown detail fields', () => {
    expect(Schema.decodeUnknownSync(ApiError)({ error: 'GrantDenied', serverId: 'myplan', name: 'x' })).toEqual({
      error: 'GrantDenied',
      serverId: 'myplan',
    })
  })
})

const ok = (path: string) => Schema.is(FilePath)(path)

describe('file paths', () => {
  it('accept plain names under the two areas', () => {
    expect(ok('/uploads/sales.csv')).toBe(true)
    expect(ok('/agent/reports/Poročilo (2).md')).toBe(true)
  })
  it('refuse other roots, dot segments, separators and empty segments', () => {
    expect(ok('/etc/passwd')).toBe(false)
    expect(ok('/uploads')).toBe(false)
    expect(ok('/uploads/../agent/x')).toBe(false)
    expect(ok('/uploads/./x')).toBe(false)
    expect(ok('/uploads//x')).toBe(false)
    expect(ok('/uploads/a\\b')).toBe(false)
    expect(ok('/uploads/a:b')).toBe(false)
  })
})
