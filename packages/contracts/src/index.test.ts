import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { ApiError } from './index.ts'

describe('contracts', () => {
  it('decodes the public error body and ignores unknown detail fields', () => {
    expect(Schema.decodeUnknownSync(ApiError)({ error: 'GrantDenied', serverId: 'myplan', name: 'x' })).toEqual({
      error: 'GrantDenied',
      serverId: 'myplan',
    })
  })
})
