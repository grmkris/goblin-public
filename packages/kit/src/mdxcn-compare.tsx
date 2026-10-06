// Adapted from mdxcn's graph-compare. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { CompareSpec } from './mdxcn-spec.ts'
import { Frame } from './mdxcn-frame.tsx'
import { entrance } from './mdxcn-motion.ts'

/** A semantic comparison table that scrolls within a narrow frame; boolean cells have readable equivalents. */
export function Compare({ title, columns, rows }: Omit<CompareSpec, 'kind'>) {
  return (
    <Frame title={title}>
      <div className="kit-mdxcn-scroll" tabIndex={0} role="region" aria-label={`${title} comparison`}>
        <table className="kit-mdxcn-compare">
          <thead>
            <tr>
              <th scope="col">
                <span className="kit-mdxcn-sr">Feature</span>
              </th>
              {columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="kit-mdxcn-enter" style={entrance(index)}>
                <th scope="row">{row.label}</th>
                {row.values.map((value, at) => (
                  <td key={at} data-positive={value === true}>
                    {typeof value === 'boolean' ? (
                      <>
                        <span aria-hidden>{value ? '✓' : '–'}</span>
                        <span className="kit-mdxcn-sr">{value ? 'Yes' : 'No'}</span>
                      </>
                    ) : (
                      value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  )
}
