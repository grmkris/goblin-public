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

/**
 * The account-confirmation mail. Purrable has no production stage, so the subject always names the host the link
 * goes to: dev mail must never pass for production mail. The link carries a one-hour, single-use token.
 */
export const verificationMail = (input: {
  readonly from: string
  readonly to: string
  readonly url: string
  readonly appUrl: string
}): MailMessage => ({
  from: input.from,
  to: input.to,
  subject: `[${new URL(input.appUrl).host}] Confirm your email for Purrable`,
  text: [
    `Open this link to confirm ${input.to} and finish creating your Purrable account:`,
    '',
    input.url,
    '',
    'The link works once and expires in one hour. If you did not sign up for Purrable, ignore this email.',
  ].join('\n'),
})
