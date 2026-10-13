import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '../components/legal.tsx'
export const Route = createFileRoute('/terms')({ component: Terms })
function Terms() {
  return (
    <LegalPage title="Terms of service">
      <p>
        goblin provides a personal AI agent, conversations and connections to tools you authorize. goblin Pro is the one
        plan; there is no trial or free tier. You pay for it in USDC on Base from your Goblin Wallet, in one of two
        ways: a day pass, US$1 for each UTC day you use goblin, taken when goblin answers your first message of the day
        (a day you do not use goblin costs nothing), or US$15 every 30 days. Prices are shown before you subscribe, and
        a subscription keeps the price you signed.
      </p>
      <p>
        You subscribe by signing one permission in your Goblin Wallet. It lets goblin take USDC transfers only, only to
        goblin&apos;s collector, at most the price for each day or each 30 days, for up to 12 months. Pro includes 800
        model Credits per account per UTC day, hand-overs, subagents and routines; model prices affect how many Credits
        a request uses. Where goblin offers it, you can choose in Settings to pay for model calls past the day&apos;s
        Credits from your Goblin Wallet, per call. You authorize each connected service and its permissions; those
        services have their own terms and charges. You must have permission to submit content and use connected
        accounts.
      </p>
      <p>
        AI outputs can be wrong. Review decisions and external actions before relying on them. A request being accepted
        does not mean an external action completed. Do not use goblin for illegal activity or to harm others, bypass
        access controls or abuse the service.
      </p>
      <p>
        You keep rights to your content. We process it to provide the service. You can disconnect services and delete
        your account in Settings. Cancel Pro before deleting your account: the permission you signed stays valid on
        chain until you revoke it or it ends. Disconnecting forgets stored credentials but does not necessarily revoke
        authorization at the remote service.
      </p>
      <p>
        Cancel Pro by revoking its permission in your Goblin Wallet (Home or Limits, then Cancel). Nothing more is
        taken, and Pro runs to the end of the day or period you paid for. If a monthly payment fails, goblin tries again
        each day for seven days while Pro continues, then Pro ends; if a day pass cannot take a day&apos;s payment,
        goblin stops answering until you add funds. Payments are transfers on the Base blockchain, and we cannot reverse
        them once made; see the refund policy. Where card checkout is offered, Pro paid by card renews until you cancel
        it in the billing portal, with applicable taxes shown at checkout. Service availability and third-party
        integrations can change. The final terms will specify operator details, liability and applicable law while
        preserving mandatory consumer rights.
      </p>
    </LegalPage>
  )
}
