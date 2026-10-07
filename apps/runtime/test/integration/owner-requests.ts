import { expect } from 'vitest'
import { Schema } from 'effect'

const Signup = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
export interface Person {
  readonly userId: string
  readonly cookie: string
  readonly ip: string
  readonly email: string
}
/** Workerd can close a retained HTTP socket; each fixture request gets its own connection. */
export const ownerFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}
export async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const email = `${crypto.randomUUID()}@fixture.test`
  const headers = { origin: 'https://goblin.test', 'content-type': 'application/json', 'cf-connecting-ip': ip }
  const sent = await ownerFetch(`${base}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  expect(sent.status).toBe(200)
  const mail = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
    await (await ownerFetch(`${base}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
  const response = await ownerFetch(`${base}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, otp: mail.code }),
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
  ownerFetch(`${base}${path}`, {
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
