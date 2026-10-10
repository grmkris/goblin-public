import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readSession } from '../../scripts/session.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'goblin-session-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const saved = (content: string, mode = 0o600): string => {
  const file = path.join(dir, `session-${files++}.json`)
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}
const session = (origin: string, cookie = 'better-auth.session_token=secret-value') =>
  JSON.stringify({ origin, cookie })

describe('readSession', () => {
  it('reads a private https or local session', () => {
    expect(readSession(saved(session('https://dev.goblin.surf')))).toEqual({
      origin: 'https://dev.goblin.surf',
      cookie: 'better-auth.session_token=secret-value',
    })
    expect(readSession(saved(session('http://localhost:18971'))).origin).toBe('http://localhost:18971')
  })

  it('refuses a file others can read, before reading it', () => {
    expect(() => readSession(saved(session('https://dev.goblin.surf'), 0o640))).toThrow(
      'private_otp_session_file_required',
    )
    expect(() => readSession(saved('not json', 0o604))).toThrow('private_otp_session_file_required')
    expect(() => readSession('')).toThrow('private_otp_session_file_required')
  })

  it('refuses a malformed file without quoting it', () => {
    for (const content of ['better-auth.session_token=secret-value', '{"origin":"https://dev.goblin.surf"}'])
      expect(() => readSession(saved(content))).toThrow(/^session_file_shape$/u)
    expect(() => readSession(saved(session('https://dev.goblin.surf', 'other=1')))).toThrow('session_file_shape')
  })

  it('refuses an origin that is neither https nor the local stack', () => {
    for (const origin of ['http://dev.goblin.surf', 'https://dev.goblin.surf/', 'not a url'])
      expect(() => readSession(saved(session(origin)))).toThrow('session_origin_must_be_https')
  })
})
