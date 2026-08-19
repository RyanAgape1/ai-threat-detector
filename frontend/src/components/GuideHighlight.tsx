import React from 'react';

interface GuideHighlightProps {
  /** Whether this is the region the operator should be filling in right now. */
  active: boolean;
  /** Matches the amber detection-events panel instead of the blue form. */
  tone?: 'blue' | 'amber';
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps a region of the setup form and, when it is the current step, runs a
 * gradient line around each edge to point at it. Inert otherwise — the wrapper
 * stays in the tree so nothing shifts as the highlight moves on.
 */
export const GuideHighlight: React.FC<GuideHighlightProps> = ({
  active, tone = 'blue', className = '', children,
}) => (
  <div
    className={`guide-region ${active ? 'guide-region--active' : ''} ${
      tone === 'amber' ? 'guide-region--amber' : ''
    } ${className}`}
  >
    {children}
    {active && (
      <span className="guide-lines" aria-hidden="true">
        <span /><span /><span /><span />
      </span>
    )}
  </div>
);
