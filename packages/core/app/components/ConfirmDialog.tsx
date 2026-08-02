'use client';

interface Props {
  title: string;
  message: React.ReactNode;
  buttons: {
    label: string;
    action: () => void | Promise<void>;
    primary?: boolean;
    danger?: boolean;
  }[];
  onClose: () => void;
}

export default function ConfirmDialog({ title, message, buttons, onClose }: Props) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={S.title}>{title}</div>
        <div style={S.message}>{message}</div>
        <div style={S.actions}>
          {buttons.map((btn, i) => (
            <button
              key={i}
              style={{
                ...S.btn,
                ...(btn.primary ? S.primary : {}),
                ...(btn.danger ? S.danger : {}),
              }}
              onClick={async () => {
                await btn.action();
                onClose();
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  dialog: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '20px',
    maxWidth: '400px',
    width: '90%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  title: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-bright)',
    marginBottom: '8px',
  },
  message: {
    fontSize: '13px',
    color: 'var(--text)',
    lineHeight: '1.5',
    marginBottom: '16px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  btn: {
    padding: '6px 16px',
    fontSize: '12px',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    background: 'none',
    fontFamily: 'inherit',
  },
  primary: {
    background: 'var(--accent)',
    color: 'var(--text-bright)',
    borderColor: 'var(--accent)',
  },
  danger: {
    background: 'var(--danger)',
    color: 'var(--text-bright)',
    borderColor: 'var(--danger)',
  },
};
