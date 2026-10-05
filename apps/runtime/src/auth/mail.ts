/** The slice of the Cloudflare Email Sending binding Purrable uses. */
export interface MailBinding {
  send(message: MailMessage): Promise<unknown>
}
export type MailMessage = {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly text: string
}

/** A configured sender: the binding plus the `From` address it is allowed to use. Absent: no mail, no verification. */
export type Mailer = { readonly binding: MailBinding; readonly from: string }

export const mailerOf = (env: { readonly MAIL?: MailBinding; readonly MAIL_SENDER?: string }): Mailer | undefined => {
  const from = env.MAIL_SENDER?.trim() ?? ''
  return env.MAIL === undefined || !/^[^\s@]+@[^\s@]+$/u.test(from) ? undefined : { binding: env.MAIL, from }
}

type MailStage = { readonly stage?: 'local' | 'dev' | 'prod' | 'test' }
const subjectPrefix = (input: MailStage & { readonly appUrl: string }): string =>
  input.stage === 'prod' ? '' : `[${new URL(input.appUrl).host}] `

export const invitationMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly url: string
    readonly code: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}Invitation to Purrable`,
  text: [
    'You have been invited to a Purrable workspace.',
    '',
    input.url,
    '',
    `Or enter this invitation code on that page: ${input.code}`,
    '',
    'The invitation expires in seven days. Sign in with this email and your own active Pro plan to join.',
    'The workspace owner can read every conversation in their workspace. If you did not expect this, ignore it.',
  ].join('\n'),
})

/** A sign-in code. The subject never contains the code, so a lock-screen preview does not give it away. */
export const codeMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly code: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}Your Purrable sign-in code`,
  text: [
    `Your Purrable sign-in code is ${input.code}`,
    '',
    'It expires in 10 minutes and works once. If you did not try to sign in, ignore this email.',
  ].join('\n'),
})

/** The password-reset mail; the link carries a one-hour, single-use token. Same host marking as confirmation. */
export const resetMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly url: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}Reset your Purrable password`,
  text: [
    `Open this link to choose a new password for ${input.to}:`,
    '',
    input.url,
    '',
    'The link works once and expires in one hour. Every device signed in to the account is signed out. If you did not',
    'ask for this, ignore this email: your password stays as it is.',
  ].join('\n'),
})

/**
 * The account-confirmation mail. Dev subjects name their host; production subjects have no stage prefix. The link carries a one-hour, single-use token.
 */
export const verificationMail = (
  input: {
    readonly from: string
    readonly to: string
    readonly url: string
    readonly appUrl: string
  } & MailStage,
): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `${subjectPrefix(input)}Confirm your email for Purrable`,
  text: [
    `Open this link to confirm ${input.to} and finish creating your Purrable account:`,
    '',
    input.url,
    '',
    'The link works once and expires in one hour. If you did not sign up for Purrable, ignore this email.',
  ].join('\n'),
})
