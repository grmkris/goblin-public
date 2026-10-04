import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './components/card.tsx'
export function AgentCard({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
