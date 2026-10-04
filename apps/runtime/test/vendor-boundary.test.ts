import { describe, expect, it } from 'vitest'
import { assertApplicationTable, isVendorTable } from '../src/storage/vendor.ts'

describe('SQLite ownership boundary', () => {
  it('protects Pi and Agents tables, including non-pi prefixes', () => {
    expect(isVendorTable('pi_submissions')).toBe(true)
    expect(isVendorTable('cf_agents_jobs')).toBe(true)
    expect(isVendorTable('_cf_KV')).toBe(true)
  })

  it('requires application-owned app_ tables', () => {
    expect(() => assertApplicationTable('app_metadata')).not.toThrow()
    expect(() => assertApplicationTable('pi_entries')).toThrow(/vendor table/u)
    expect(() => assertApplicationTable('users')).toThrow(/app_ prefix/u)
  })
})
