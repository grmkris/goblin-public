import { describe, expect, it } from 'vitest'
import { assertApplicationTable, isVendorTable } from '../src/storage/vendor.ts'

/** What a migration of table `name` is refused with, or nothing. */
const refused = (name: string): unknown => {
  try {
    assertApplicationTable(name)
  } catch (error) {
    return error
  }
  return undefined
}

describe('SQLite ownership boundary', () => {
  it('protects Pi and Agents tables, including non-pi prefixes', () => {
    expect(isVendorTable('pi_submissions')).toBe(true)
    expect(isVendorTable('cf_agents_jobs')).toBe(true)
    expect(isVendorTable('_cf_KV')).toBe(true)
    expect(isVendorTable('cf_workspace_files')).toBe(true)
  })

  it('requires application-owned app_ tables', () => {
    expect(() => assertApplicationTable('app_metadata')).not.toThrow()
    expect(refused('pi_entries')).toMatchObject({ _tag: 'Internal', reason: expect.stringMatching(/vendor table/u) })
    expect(refused('users')).toMatchObject({ _tag: 'Internal', reason: expect.stringMatching(/app_ prefix/u) })
  })
})
