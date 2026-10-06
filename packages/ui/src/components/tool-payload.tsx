import type { ReactNode } from 'react'
import { CopyButton } from './copy-button.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx'

/** A labelled part of an expanded tool call. Raw preserves the complete original result; Copy always copies it. */
function ToolPayload({
  label,
  raw,
  structured,
  children,
}: {
  readonly label: string
  readonly raw: string
  readonly structured: boolean
  readonly children: ReactNode
}) {
  return (
    <Tabs defaultValue="tree" className="min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {structured && (
            <TabsList variant="line" aria-label={`${label} format`}>
              <TabsTrigger value="tree">Tree</TabsTrigger>
              <TabsTrigger value="raw">Raw</TabsTrigger>
            </TabsList>
          )}
          <CopyButton text={raw} label={`Copy ${label.toLowerCase()}`} />
        </div>
      </div>
      <TabsContent value="tree" className="max-h-80 min-w-0 overflow-auto">
        <div className="flex min-w-0 flex-col gap-2">{children}</div>
      </TabsContent>
      {structured && (
        <TabsContent value="raw" className="max-h-80 min-w-0 overflow-auto">
          <pre className="m-0 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-6">{raw}</pre>
        </TabsContent>
      )}
    </Tabs>
  )
}

function ToolPayloadText({ children }: { readonly children: string }) {
  return <pre className="m-0 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-6">{children}</pre>
}

export { ToolPayload, ToolPayloadText }
