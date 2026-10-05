export const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export const table = (caption: string, headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  `<div class="scroll"><table><caption>${escape(caption)}</caption><thead><tr>${headers.map((header) => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
