import { useEffect } from 'react'
import { receiptExtrasOf, spendOf } from './decode.ts'
import { ViewFrame, ViewStatus } from './frame.tsx'
import { mount } from './mount.tsx'
import { Receipt } from './receipt.tsx'
import { modelSummary } from './receipt-model.ts'
import { useWalletApp } from './use-wallet-app.ts'

function ReceiptView() {
  const { app, error, result, cancelled } = useWalletApp('Goblin Wallet receipt')
  const spend = spendOf(result)
  const operation = spend?.operation
  const summary = operation === undefined ? undefined : modelSummary(operation)

  // Tell the model what this view shows, once per state: a short line, never the paid content.
  useEffect(() => {
    if (app === null || summary === undefined) return
    app.updateModelContext({ content: [{ type: 'text', text: summary }] }).catch(() => {
      // expected: a host without model context support simply does not take the summary
    })
  }, [app, summary])

  const extras = receiptExtrasOf(result)
  return (
    <ViewFrame>
      {spend === undefined ? (
        <ViewStatus error={error}>
          {cancelled ? 'The wallet call was cancelled.' : 'Waiting for the receipt…'}
        </ViewStatus>
      ) : (
        <Receipt
          result={spend}
          approveUrl={extras.approveUrl}
          limits={extras.limits}
          onOpenLink={(url) => {
            app?.openLink({ url }).catch(() => {
              // expected: the host may refuse; the button then does nothing, as in any sandboxed frame
            })
          }}
        />
      )}
    </ViewFrame>
  )
}

mount(<ReceiptView />)
