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

  it('carries daily token overrides over as Credits, at 2,500 tokens per Credit', () => {
    const credits = migrations.findIndex((name) => name.startsWith('0010_daily_credits'))
    expect(credits).toBeGreaterThan(0)
    const db = new DatabaseSync(':memory:')
    apply(db, migrations.slice(0, credits))
    const user = db.prepare(
      'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    const account = db.prepare(
      "INSERT INTO app_billing_accounts (user_id, plan_override, override_stage, daily_tokens, created_at, updated_at) VALUES (?, 'pro', 'dev', ?, 0, 0)",
    )
    for (const [id, tokens] of [
      ['pro', 2_000_000],
      ['unlimited', 1_000_000_000_000],
      ['tiny', 17],
      ['plain', null],
    ] as const) {
      user.run(id, id, `${id}@goblin.test`, NOW, NOW)
      account.run(id, tokens)
    }

    apply(db, migrations.slice(credits))

    expect(db.prepare('SELECT user_id, daily_credits FROM app_billing_accounts ORDER BY user_id').all()).toEqual([
      { user_id: 'plain', daily_credits: null },
      { user_id: 'pro', daily_credits: 800 },
      { user_id: 'tiny', daily_credits: 1 },
      { user_id: 'unlimited', daily_credits: 400_000_000 },
    ])
  })

  it('keys wallet subscriptions by subscription, keeps the ones before as monthly, and lets a day pass beside one', () => {
    const billing = migrations.findIndex((name) => name.startsWith('0012_wallet_billing'))
    expect(billing).toBeGreaterThan(0)
    const db = new DatabaseSync(':memory:')
    apply(db, migrations.slice(0, billing))
    db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(
      'u1',
      'u1',
      'u1@goblin.test',
      NOW,
      NOW,
    )
    db.prepare(
      `INSERT INTO app_billing_wallet_subscriptions (user_id, subscription_id, status, amount_usd, period_days, starts_at,
        period, paid_through, next_attempt_at, created_at, updated_at) VALUES ('u1', 'sub_m', 'active', '10.00', 30, 5,
        1, 50, 50, 5, 6)`,
    ).run()

    apply(db, migrations.slice(billing))

    expect(
      db
        .prepare(
          'SELECT subscription_id, user_id, billing, status, amount_usd, period, paid_through FROM app_billing_wallet_subscriptions',
        )
        .all(),
    ).toEqual([
      {
        subscription_id: 'sub_m',
        user_id: 'u1',
        billing: 'month',
        status: 'active',
        amount_usd: '10.00',
        period: 1,
        paid_through: 50,
      },
    ])
    const insert = db.prepare(
      `INSERT INTO app_billing_wallet_subscriptions (subscription_id, user_id, billing, status, amount_usd, period_days,
        starts_at, created_at, updated_at) VALUES (?, 'u1', ?, ?, '1.00', 1, 0, 7, 7)`,
    )
    insert.run('sub_d', 'day', 'superseded')
    expect(() => insert.run('sub_x', 'week', 'active')).toThrow()
    expect(() => insert.run('sub_y', 'day', 'free')).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS rows FROM app_billing_wallet_subscriptions').get()).toEqual({ rows: 2 })
  })
})
