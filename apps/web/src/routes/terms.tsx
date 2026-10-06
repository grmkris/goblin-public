import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/terms')({ component: Terms })
function Terms() {
  return (
    <LegalPage title="Terms of service">
      <p>
        goblin provides a personal AI agent, conversations and connections to tools you authorize. Pro costs US$10 per
        month, with applicable taxes shown at checkout. There is no trial or free tier. Your subscription renews monthly
        until cancelled through the billing portal.
      </p>
      <p>
        Pro includes 2 million weighted tokens per account per UTC day. Model prices affect the weight. You authorize
        each connected service and its permissions; those services have their own terms and charges. You must have
        permission to submit content and use connected accounts.
      </p>
      <p>
        AI outputs can be wrong. Review decisions and external actions before relying on them. A request being accepted
        does not mean an external action completed. Do not use goblin for illegal activity or to harm others, bypass
        access controls or abuse the service.
      </p>
      <p>
        You keep rights to your content. We process it to provide the service. You can cancel, disconnect services and
        delete your account in Settings. Cancel billing before deleting; disconnecting forgets stored credentials but
        does not necessarily revoke authorization at the remote service.
      </p>
      <p>
        Access continues through a paid period after cancellation. Failed renewals may have a short grace period, then
        agent access ends. Service availability and third-party integrations can change. The final terms will specify
        operator details, liability and applicable law while preserving mandatory consumer rights.
      </p>
    </LegalPage>
  )
}
