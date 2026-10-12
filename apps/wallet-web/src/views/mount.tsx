import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './views.css'

/** Mounts a view into `#root`. */
export function mount(view: ReactNode) {
  const root = document.getElementById('root')
  if (root === null) throw new Error('mount: #root is missing')
  createRoot(root).render(<StrictMode>{view}</StrictMode>)
}
