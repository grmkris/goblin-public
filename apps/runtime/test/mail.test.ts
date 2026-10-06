import { describe, expect, it } from 'vitest'
import { codeMail, mailerOf } from '../src/auth/mail.ts'

const binding = { send: () => Promise.resolve(undefined) }

describe('sign-in mail configuration (unit)', () => {
  it('turns mail on only with both a binding and a valid sender', () => {
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
      appUrl: 'https://goblin.surf',
      stage: 'prod' as const,
    }
    expect(codeMail(base).subject).toBe('Your goblin sign-in code')
    expect(codeMail({ ...base, appUrl: 'https://dev.goblin.surf', stage: 'dev' }).subject).toBe(
      '[dev.goblin.surf] Your goblin sign-in code',
    )
  })
})
