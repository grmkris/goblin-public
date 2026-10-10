import { type ReactNode, useRef } from 'react'
import { EllipsisIcon } from 'lucide-react'
import {
  type ExtraProps,
  extractTableDataFromElement,
  type TableData,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from 'streamdown'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@goblin/ui'

/** Saves `text` as a file named `name` through the browser's own download. */
function save(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * A table in a reply: it scrolls sideways instead of widening the conversation, and a menu in its corner copies it as
 * Markdown, CSV or TSV, or saves it as CSV. The table is read from what is on screen (`extractTableDataFromElement`),
 * so what is copied is what the owner sees. The clipboard can refuse; then nothing changes.
 */
export function ReplyTable({ children }: { readonly children?: ReactNode } & ExtraProps) {
  const table = useRef<HTMLTableElement>(null)
  const read = (act: (data: TableData) => void) => {
    if (table.current !== null) act(extractTableDataFromElement(table.current))
  }
  const copy = (format: (data: TableData) => string) =>
    read((data) => {
      navigator.clipboard.writeText(format(data)).catch(() => {
        // expected: a refused clipboard leaves things as they were
      })
    })
  return (
    <div className="table-block">
      <div className="typeset-scroll">
        <table ref={table}>{children}</table>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" className="block-action" aria-label="Table actions" />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => copy(tableDataToMarkdown)}>Copy as Markdown</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy(tableDataToCSV)}>Copy as CSV</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy(tableDataToTSV)}>Copy as TSV</DropdownMenuItem>
          <DropdownMenuItem onClick={() => read((data) => save(tableDataToCSV(data), 'table.csv'))}>
            Download CSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
