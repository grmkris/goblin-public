import { expect } from 'vitest'
import { Schema } from 'effect'

const Signup = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
export interface Person {
  readonly userId: string
  readonly cookie: string
  readonly ip: string
  readonly email: string
}
export async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const email = `${crypto.randomUUID()}@fixture.test`
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: 'https://goblin.test', 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      email,
      name: 'Owner fixture',
      password: 'fixture-password-12345',
    }),
  })
  expect(response.status).toBe(200)
  return {
    userId: Schema.decodeUnknownSync(Signup)(await response.json()).user.id,
    ip,
    email,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  }
}
export const call = (base: string, who: Person, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: who.cookie,
      origin: 'https://goblin.test',
      'content-type': 'application/json',
      'x-goblin-csrf': '1',
      'cf-connecting-ip': who.ip,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
export async function waitFor(base: string, who: Person, path: string, expected: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(base, who, path)
    expect(response.status).toBe(200)
    const value = await response.text()
    if (value.includes(expected)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`missing fixture response ${expected}`)
}
