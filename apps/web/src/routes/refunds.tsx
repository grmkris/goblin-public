import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/refunds')({ component: Refunds })
function Refunds() {
  return (
    <LegalPage title="Refund and cancellation policy">
      <p>
        Cancel your recurring subscription in Settings → Billing → Manage subscription. Cancellation stops future
        renewal and keeps access through the paid period. Deleting a goblin account is separate from cancelling payment.
      </p>
      <p>
        If you were charged incorrectly, paid twice or could not use the service, keep your Dodo checkout receipt and
        contact the operator. Refund eligibility, request deadlines and the support contact will be finalized before
        public launch. Approved refunds are returned through Dodo to the original payment method; bank processing time
        varies.
      </p>
      <p>
        Mandatory consumer refund and withdrawal rights apply. This draft does not restrict those rights. The operator
        must review renewal notices, digital-service consent and jurisdiction-specific requirements before live payments
        are enabled.
      </p>
    </LegalPage>
  )
}
