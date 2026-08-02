'use client';

interface Props {
  left?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}

export default function TopBar({ left, children, right }: Props) {
  return (
    <div style={S.bar}>
      {left}
      <div style={S.content}>{children}</div>
      {right}
    </div>
  );
}

// Standard action button style for TopBar — use this for all icons in the bar
export const topBarActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '36px',
  height: '36px',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  flexShrink: 0,
  padding: 0,
};

// Shared "back to file tree" affordance (mobile). Used by the dedicated
// viewers (image/PDF/CSV) so the chevron button lives in one place rather than
// being copy-pasted into each viewer.
export function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      style={topBarActionStyle}
      onClick={onBack}
      title="Back to file tree"
      aria-label="Back to file tree"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    height: 'var(--tab-height)',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: 0,
  },
};
