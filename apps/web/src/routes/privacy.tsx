import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/privacy')({ component: Privacy })
function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        We process your account email, name, sign-in credentials and sessions; conversations, uploaded context, tool
        results, usage and settings; and the permissions and credentials of services you connect. Sign-in codes are
        stored hashed and expire after 10 minutes.
      </p>
      <p>
        Cloudflare hosts goblin and sends sign-in mail. Model requests go through our model gateway to the selected
        model provider, including conversation context and relevant tool results. A connected tool receives the data
        needed for its authorized request. Dodo Payments handles checkout, customer and subscription information; goblin
        does not store card details.
      </p>
      <p>
        Outbound OAuth tokens are encrypted at rest. Essential session cookies support sign-in. Runtime logs contain
        route, request ID, status, error category and a short error message, and how each turn ran (timings, token
        counts, tool and model names, outcomes), without request bodies, conversation content or credentials. The
        verified billing webhook ledger retains subscription data for reconciliation; processed payloads are cleared
        after 30 days by the billing job.
      </p>
      <p>
        Your agent keeps a record of how each turn ran (the same timings, counts, names and outcomes, never content) for
        30 days. An app you connect to goblin over MCP gets only what you allow on the consent screen: asking your
        agent, or reading your conversations and how each turn ran without changing anything.
      </p>
      <p>
        Your agent data remains until you delete your account. Deletion erases its conversations, connections and app
        state and removes account billing mappings; payment provider records and legally required records may remain
        with their providers. Outbound authorizations may need to be revoked at those services too.
      </p>
      <p>
        The final policy will identify the controller, contact for access or deletion requests, legal bases,
        subprocessors, international transfers and retention periods. Contact information is pending operator review.
      </p>
    </LegalPage>
  )
}
