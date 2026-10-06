import { describe, expect, it } from 'vitest'
import { passkeyPlugin } from '../src/auth/passkey.ts'

/** The one field of an assertion result the policy reads. */
type Assertion = { readonly verification: { readonly authenticationInfo: { readonly userVerified: boolean } } }
const assertion = (userVerified: boolean): Assertion => ({ verification: { authenticationInfo: { userVerified } } })

describe('passkey policy (unit)', () => {
  const plugin = passkeyPlugin('https://goblin-dev.example.workers.dev/')

  it("binds the relying party to the app's own host and asks for a discoverable, user-verified credential", () => {
    expect(plugin.options).toMatchObject({
      rpID: 'goblin-dev.example.workers.dev',
      origin: 'https://goblin-dev.example.workers.dev',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
  })

  it('refuses a sign-in the authenticator did not verify the person for', async () => {
    // SAFETY: the policy reads only `verification.authenticationInfo.userVerified`, which `Assertion` provides.
    const check = plugin.options?.authentication?.afterVerification as ((input: Assertion) => unknown) | undefined
    expect(check).toBeTypeOf('function')
    await expect(Promise.resolve().then(() => check?.(assertion(false)))).rejects.toThrow('did not verify')
    await expect(Promise.resolve().then(() => check?.(assertion(true)))).resolves.toBeUndefined()
  })
})
