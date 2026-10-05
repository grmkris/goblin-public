import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@purrable/ui'
export function LegalPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">Draft for review · 5 October 2026</p>
          {children}
          <p className="text-sm">
            Operator identity, contact address, jurisdiction and final policy details are pending review before public
            launch.
          </p>
          <nav aria-label="Policies" className="flex flex-wrap gap-4 text-sm underline">
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <a href="/refunds">Refunds</a>
            <a href="/subscribe">Purrable Pro</a>
          </nav>
        </div>
      </CardContent>
    </Card>
  )
}
