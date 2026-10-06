// The Telegram channel's way in (src/channel/doorbell.ts): the hook token is the user's alone, and a doorbell counts
// only when myagent signed it with the agent's secret within five minutes, the way myagent signs (src/push.ts there).
import { describe, expect, test } from 'vitest'
import { doorbellValid, hookToken, hookTokenValid, hookUrl } from '../src/channel/doorbell.ts'

const KEY = 'cHVycmFibGUtdGVzdC1rZXktMzItYnl0ZXMtbG9uZyE='
const SECRET = 'synthetic-doorbell-secret'
const BODY = '{"botId":"7","cursor":"0000000000000003"}'
const NOW = 1_700_000_000_000

/** myagent's signature: hex HMAC-SHA256 of `<timestamp>.<body>` under the secret. */
async function sign(timestamp: string, body = BODY): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('channel doorbell', () => {
  test("a hook token opens only its own user's hook", async () => {
    const token = await hookToken(KEY, 'user-1')
    expect(token).toMatch(/^[\w-]{43}$/u)
    expect(await hookTokenValid(KEY, 'user-1', token)).toBe(true)
    expect(await hookTokenValid(KEY, 'user-2', token)).toBe(false)
    expect(hookUrl('https://goblin.example/anything', 'user-1', token)).toBe(
      `https://goblin.example/hooks/myagent/user-1/${token}`,
    )
  })

  test('a doorbell counts only signed with the secret, for its own body, within five minutes', async () => {
    const recent = String(NOW - 60_000)
    expect(await doorbellValid(SECRET, { body: BODY, timestamp: recent, signature: await sign(recent) }, NOW)).toBe(
      true,
    )
    expect(
      await doorbellValid('another-secret', { body: BODY, timestamp: recent, signature: await sign(recent) }, NOW),
    ).toBe(false)
    const changed = BODY.replace('3', '4')
    expect(await doorbellValid(SECRET, { body: changed, timestamp: recent, signature: await sign(recent) }, NOW)).toBe(
      false,
    )
    const stale = String(NOW - 6 * 60_000)
    expect(await doorbellValid(SECRET, { body: BODY, timestamp: stale, signature: await sign(stale) }, NOW)).toBe(false)
  })
})
