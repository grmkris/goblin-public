import { describe, expect, it } from 'vitest'
import { mailerOf, verificationMail } from '../src/auth/mail.ts'

const binding = { send: () => Promise.resolve(undefined) }

describe('verification mail (unit)', () => {
  it('names the host in the subject and carries the link only in the body', () => {
    const url = 'https://purrable-dev.example.workers.dev/api/auth/verify-email?token=abc&callbackURL=%2F'
    const mail = verificationMail({
      from: 'purrable@mytab.lol',
      to: 'someone@example.com',
      url,
      appUrl: 'https://purrable-dev.example.workers.dev',
    })
    expect(mail.subject).toBe('[purrable-dev.example.workers.dev] Confirm your email for Purrable')
    expect(mail.subject).not.toContain('abc')
    expect(mail.text).toContain(url)
    expect(mail).toMatchObject({ from: 'purrable@mytab.lol', to: 'someone@example.com' })
  })

  it('turns mail (and so verification) on only with both a binding and a valid sender', () => {
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: ' purrable@mytab.lol ' })?.from).toBe('purrable@mytab.lol')
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: '' })).toBeUndefined()
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: 'not an address' })).toBeUndefined()
    expect(mailerOf({ MAIL_SENDER: 'purrable@mytab.lol' })).toBeUndefined()
  })
})
