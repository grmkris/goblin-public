import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/refunds')({ component: Refunds })
function Refunds() {
  return (
    <LegalPage title="Refund and cancellation policy">
      <p>
        Cancel goblin Pro in your Goblin Wallet: on Home or Limits, choose Cancel and sign. That revokes the permission
        you signed, so nothing more is taken, and Pro runs to the end of the day or period you paid for. Deleting a
        goblin account is separate from cancelling payment.
      </p>
      <p>
        Payments are USDC transfers on the Base blockchain. We cannot reverse a transfer once it is made, but goblin
        refunds a payment taken in error, such as a day pass charged on a day you did not use goblin: contact the
        operator with the payment from your Goblin Wallet&apos;s Activity, and the refund is sent in USDC to the wallet
        it came from. Where card checkout is offered, keep your checkout receipt; approved card refunds go back to the
        original payment method, and bank processing time varies.
      </p>
      <p>Mandatory consumer refund and withdrawal rights apply. This policy does not restrict those rights.</p>
    </LegalPage>
  )
}
