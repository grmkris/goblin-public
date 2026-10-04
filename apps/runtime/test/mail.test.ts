import { describe, expect, it } from 'vitest'
import { codeMail, mailerOf, resetMail, verificationMail } from '../src/auth/mail.ts'

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

  it('marks the reset mail the same way and keeps its link out of the subject', () => {
    const url = 'https://purrable-dev.example.workers.dev/api/auth/reset-password/tok123?callbackURL=%2Freset-password'
    const mail = resetMail({
      from: 'purrable@mytab.lol',
      to: 'a@example.com',
      url,
      appUrl: 'https://purrable-dev.example.workers.dev',
    })
    expect(mail.subject).toBe('[purrable-dev.example.workers.dev] Reset your Purrable password')
    expect(mail.subject).not.toContain('tok123')
    expect(mail.text).toContain(url)
  })

  it('turns mail (and so verification) on only with both a binding and a valid sender', () => {
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: ' purrable@mytab.lol ' })?.from).toBe('purrable@mytab.lol')
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: '' })).toBeUndefined()
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: 'not an address' })).toBeUndefined()
    expect(mailerOf({ MAIL_SENDER: 'purrable@mytab.lol' })).toBeUndefined()
  })
})

describe('sign-in code mail (unit)', () => {
  it('puts the code in the body only', () => {
    const mail = codeMail({
      from: 'purrable@mytab.lol',
      to: 'a@example.com',
      code: '482913',
      appUrl: 'https://p.example',
    })
    expect(mail.subject).toBe('[p.example] Your Purrable sign-in code')
    expect(mail.subject).not.toContain('482913')
    expect(mail.text).toContain('482913')
  })
})
