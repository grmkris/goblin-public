import { describe, expect, it } from 'vitest'
import { codeMail, mailerOf, resetMail, verificationMail } from '../src/auth/mail.ts'

const binding = { send: () => Promise.resolve(undefined) }

describe('verification mail (unit)', () => {
  it('names the host in the subject and carries the link only in the body', () => {
    const url = 'https://goblin-dev.example.workers.dev/api/auth/verify-email?token=abc&callbackURL=%2F'
    const mail = verificationMail({
      from: 'goblin@mytab.lol',
      to: 'someone@example.com',
      url,
      appUrl: 'https://goblin-dev.example.workers.dev',
    })
    expect(mail.subject).toBe('[goblin-dev.example.workers.dev] Confirm your email for goblin')
    expect(mail.subject).not.toContain('abc')
    expect(mail.text).toContain(url)
    expect(mail).toMatchObject({ from: 'goblin@mytab.lol', to: 'someone@example.com' })
  })

  it('marks the reset mail the same way and keeps its link out of the subject', () => {
    const url = 'https://goblin-dev.example.workers.dev/api/auth/reset-password/tok123?callbackURL=%2Freset-password'
    const mail = resetMail({
      from: 'goblin@mytab.lol',
      to: 'a@example.com',
      url,
      appUrl: 'https://goblin-dev.example.workers.dev',
    })
    expect(mail.subject).toBe('[goblin-dev.example.workers.dev] Reset your goblin password')
    expect(mail.subject).not.toContain('tok123')
    expect(mail.text).toContain(url)
  })

  it('turns mail (and so verification) on only with both a binding and a valid sender', () => {
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: ' goblin@mytab.lol ' })?.from).toBe('goblin@mytab.lol')
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: '' })).toBeUndefined()
    expect(mailerOf({ MAIL: binding, MAIL_SENDER: 'not an address' })).toBeUndefined()
    expect(mailerOf({ MAIL_SENDER: 'goblin@mytab.lol' })).toBeUndefined()
  })
})

describe('sign-in code mail (unit)', () => {
  it('puts the code in the body only', () => {
    const mail = codeMail({
      from: 'goblin@mytab.lol',
      to: 'a@example.com',
      code: '482913',
      appUrl: 'https://p.example',
    })
    expect(mail.subject).toBe('[p.example] Your goblin sign-in code')
    expect(mail.subject).not.toContain('482913')
    expect(mail.text).toContain('482913')
  })
})

describe('stage mail subjects', () => {
  it('keeps dev marked and production unmarked, with no code or token in the subject', () => {
    const base = {
      from: 'hello@goblin.surf',
      to: 'a@example.com',
      code: '482913',
      url: 'https://goblin.surf/api/auth/verify-email?token=abc',
      appUrl: 'https://goblin.surf',
      stage: 'prod' as const,
    }
    expect(codeMail(base).subject).toBe('Your goblin sign-in code')
    expect(resetMail(base).subject).toBe('Reset your goblin password')
    expect(verificationMail(base).subject).toBe('Confirm your email for goblin')
    expect(codeMail({ ...base, appUrl: 'https://dev.goblin.surf', stage: 'dev' }).subject).toBe(
      '[dev.goblin.surf] Your goblin sign-in code',
    )
  })
})
