/**
 * Icons for the Changes panel and status bar, in the same Feather-style
 * stroke as components/icons.tsx (kept here so that shared module stays
 * conflict-free).
 */

import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function Stroke({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, display: 'block' }}
    >
      {children}
    </svg>
  );
}

/** Sidebar "Changes" section (source control). */
export const SourceControlIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7" />
    <line x1="6" y1="9" x2="6" y2="21" />
  </Stroke>
);

/** Open the file itself (not its diff). */
export const OpenFileIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </Stroke>
);

/** Reveal the file in the Files tree. */
export const RevealIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Stroke>
);

export const PlusIcon = (p: IconProps) => (
  <Stroke {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Stroke>
);

export const MinusIcon = (p: IconProps) => (
  <Stroke {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </Stroke>
);

/** Discard (revert) changes. */
export const DiscardIcon = (p: IconProps) => (
  <Stroke {...p}>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </Stroke>
);

export const CheckIcon = (p: IconProps) => (
  <Stroke {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Stroke>
);
