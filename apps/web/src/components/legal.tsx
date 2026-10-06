import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { AuthShell } from './auth-shell.tsx'

/** A policy page: its text set as prose, then the other policies and the way back. */
export function LegalPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <AuthShell
      size="lg"
      title={title}
      description="Draft for review · 5 October 2026"
      footer={
        <>
          <nav aria-label="Policies" className="legal-links">
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/refunds">Refunds</Link>
            <Link to="/subscribe">goblin Pro</Link>
          </nav>
          <p>
            <Link to="/">Back to goblin</Link>
          </p>
        </>
      }
    >
      <article className="typeset">
        {children}
        <p>
          Operator identity, contact address, jurisdiction and final policy details are pending review before public
          launch.
        </p>
      </article>
    </AuthShell>
  )
}
