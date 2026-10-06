import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIR = fileURLToPath(new URL('../migrations', import.meta.url).href)
const migrations = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .toSorted()
const apply = (db: DatabaseSync, names: readonly string[]) => {
  for (const name of names) db.exec(readFileSync(join(DIR, name), 'utf8'))
}
const NOW = '2026-10-06T00:00:00.000Z'

describe('auth store migrations (unit)', () => {
  it('lets clients registered before one /mcp ask for inspection, and retires the old resources', () => {
    const inspection = migrations.findIndex((name) => name.startsWith('0009_mcp_inspection_scope'))
    expect(inspection).toBeGreaterThan(0)
    const db = new DatabaseSync(':memory:')
    apply(db, migrations.slice(0, inspection))
    const client = db.prepare(
      'INSERT INTO oauthClient (id, clientId, scopes, redirectUris, createdAt) VALUES (?, ?, ?, ?, ?)',
    )
    client.run('1', 'old', '["openid","profile","email","offline_access"]', '[]', NOW)
    client.run('2', 'between', '["openid","offline_access","goblin:inspect","goblin:operator"]', '[]', NOW)
    client.run('3', 'unset', null, '[]', NOW)
    const resource = db.prepare('INSERT INTO oauthResource (id, identifier, name) VALUES (?, ?, ?)')
    for (const [id, path] of [
      ['r1', '/mcp'],
      ['r2', '/mcp/inspect'],
      ['r3', '/mcp/operator'],
    ] as const)
      resource.run(id, `https://dev.goblin.surf${path}`, path)
    db.prepare('INSERT INTO oauthClientResource (id, clientId, resourceId) VALUES (?, ?, ?)').run(
      'l1',
      'between',
      'https://dev.goblin.surf/mcp/inspect',
    )

    apply(db, migrations.slice(inspection))

    const scopes = db.prepare('SELECT clientId, scopes FROM oauthClient ORDER BY id').all()
    expect(scopes).toEqual([
      { clientId: 'old', scopes: '["openid","profile","email","offline_access","goblin:inspect"]' },
      { clientId: 'between', scopes: '["openid","offline_access","goblin:inspect"]' },
      { clientId: 'unset', scopes: null },
    ])
    expect(db.prepare('SELECT identifier FROM oauthResource').all()).toEqual([
      { identifier: 'https://dev.goblin.surf/mcp' },
    ])
    expect(db.prepare('SELECT COUNT(*) AS links FROM oauthClientResource').get()).toEqual({ links: 0 })
  })
})
