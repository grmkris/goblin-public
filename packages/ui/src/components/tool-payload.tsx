import type { ReactNode } from 'react'
import { CopyButton } from './copy-button.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx'

/** How a payload is presented: a JSON tree, formatted Markdown, or plain text, which needs no second view. */
type ToolPayloadView = 'tree' | 'formatted' | 'plain'

const VIEW_LABEL = { tree: 'Tree', formatted: 'Formatted' } as const

/**
 * A labelled part of an expanded tool call. A tree or formatted view opens first with Raw beside it; Raw preserves the
 * complete original result and Copy always copies it.
 */
function ToolPayload({
  label,
  raw,
  view,
  children,
}: {
  readonly label: string
  readonly raw: string
  readonly view: ToolPayloadView
  readonly children: ReactNode
}) {
  return (
    <Tabs defaultValue="view" className="min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {view !== 'plain' && (
            <TabsList variant="line" aria-label={`${label} format`}>
              <TabsTrigger value="view">{VIEW_LABEL[view]}</TabsTrigger>
              <TabsTrigger value="raw">Raw</TabsTrigger>
            </TabsList>
          )}
          <CopyButton text={raw} label={`Copy ${label.toLowerCase()}`} />
        </div>
      </div>
      <TabsContent value="view" className="max-h-80 min-w-0 overflow-auto">
        <div className="flex min-w-0 flex-col gap-2">{children}</div>
      </TabsContent>
      {view !== 'plain' && (
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

export { ToolPayload, ToolPayloadText, type ToolPayloadView }
