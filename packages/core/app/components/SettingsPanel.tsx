'use client';

import { useState, useEffect, useCallback } from 'react';
import { track, setClientTelemetryEnabled } from '../telemetryClient';
import TopBar, { topBarActionStyle } from './TopBar';
import { ResizeHandle, type DragInfo } from './ResizeHandle';
import type {
  WorkspacesPanelMode,
  FilesPanelMode,
  BrowserPanelMode,
  BrowserInspectorPosition,
} from '../../lib/settings';

// Lower bound for the resizable overlay width. The body lays out as
// label/control rows, so anything narrower than this starts to crowd.
const MIN_WIDTH = 320;

const PANEL_MODES = ['docked', 'overlay'] as const;
const INSPECTOR_POSITIONS = ['hidden', 'right', 'bottom'] as const;

/**
 * One label/control row of mutually exclusive options. Four settings share this
 * shape, so the markup — and any future change to it, such as real arrow-key
 * navigation — lives in one place.
 */
function ModeRadioGroup<T extends string>({
  label,
  ariaLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div style={S.row}>
      <label style={S.label}>{label}</label>
      <div style={S.control} role="radiogroup" aria-label={ariaLabel}>
        {options.map((option) => (
          <button
            key={option}
            role="radio"
            aria-checked={value === option}
            style={{ ...S.shellBtn, ...(value === option ? S.shellBtnActive : {}) }}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

// terminalRenderer is intentionally absent: it has no UI control, and the
// server's shallow-merge save preserves any persisted value (incl. a manually
// set "dom"), so the panel must not echo it back lest a failed load clobber it.
interface Settings {
  terminalFontSize: number;
  defaultShell: string;
  telemetryEnabled: boolean;
}

interface Props {
  /** Panel width in px (desktop). 0 → full width (mobile / no resize). */
  width: number;
  isMobile?: boolean;
  onClose: () => void;
  /** Persists the dragged width back to host state. */
  onWidthChange: (width: number) => void;
  /** Bracket a resize drag so the host can shield the terminal/iframes. */
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /**
   * Workspaces-panel display mode. Controlled by host state so the panel
   * applies live without waiting for Save (the other settings here only
   * take effect on new terminals, so they keep the Save flow).
   */
  workspacesPanelMode: WorkspacesPanelMode;
  onWorkspacesPanelModeChange: (mode: WorkspacesPanelMode) => void;
  /** Files-panel display mode. Same live-apply pattern as workspaces. */
  filesPanelMode: FilesPanelMode;
  onFilesPanelModeChange: (mode: FilesPanelMode) => void;
  /** Browser-view display and inspector placement. Both apply live. */
  browserPanelMode: BrowserPanelMode;
  onBrowserPanelModeChange: (mode: BrowserPanelMode) => void;
  browserInspectorPosition: BrowserInspectorPosition;
  onBrowserInspectorPositionChange: (position: BrowserInspectorPosition) => void;
}

export default function SettingsPanel({
  width,
  isMobile,
  onClose,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  workspacesPanelMode,
  onWorkspacesPanelModeChange,
  filesPanelMode,
  onFilesPanelModeChange,
  browserPanelMode,
  onBrowserPanelModeChange,
  browserInspectorPosition,
  onBrowserInspectorPositionChange,
}: Props) {
  const [settings, setSettings] = useState<Settings>({
    terminalFontSize: 18,
    defaultShell: 'bash',
    telemetryEnabled: true,
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/settings ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setSettings({
          terminalFontSize: data.terminalFontSize || 18,
          defaultShell: data.defaultShell || 'bash',
          telemetryEnabled: data.telemetryEnabled !== false,
        });
        setLoaded(true);
      })
      .catch(() => setSaveError('Could not load settings. Saving is disabled to avoid overwriting them.'));
  }, []);

  const handleSave = useCallback(async () => {
    // Guard against saving before a successful load — otherwise the hardcoded
    // defaults above would overwrite the user's persisted settings on disk.
    if (!loaded) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }));
        setSaveError((err as { error?: string }).error || 'Save failed');
        return;
      }
    } catch {
      setSaveError('Save failed — could not reach the server.');
      return;
    } finally {
      setSaving(false);
    }
    // Record the change while still opted in, then apply the telemetry choice
    // live (opting out stops further client capture without a reload).
    if (settings.telemetryEnabled) track('settings_changed');
    setClientTelemetryEnabled(settings.telemetryEnabled);
    onClose();
  }, [settings, loaded, onClose]);

  // Left-edge drag: width grows as the pointer moves left, mirroring the
  // files overlay. Clamped to [MIN_WIDTH, viewport - 40].
  const handlePanelDrag = useCallback(
    (info: DragInfo) => {
      const maxW = window.innerWidth - 40;
      onWidthChange(Math.min(maxW, Math.max(MIN_WIDTH, window.innerWidth - info.x)));
    },
    [onWidthChange],
  );

  const closeButton = (
    <button style={topBarActionStyle} onClick={onClose} title="Close settings">
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

  return (
    <div style={{ ...S.container, width: width > 0 ? `${width}px` : '100%' }}>
      {/* Left-edge resize, desktop only — mirrors the files overlay. */}
      {!isMobile && (
        <ResizeHandle
          axis="x"
          variant="edge"
          style={{ left: -3 }}
          onStart={onResizeStart}
          onDrag={handlePanelDrag}
          onEnd={onResizeEnd}
        />
      )}

      <TopBar right={closeButton}>
        <span style={S.title}>SETTINGS</span>
      </TopBar>

      <div style={S.body}>
        <div style={S.row}>
          <label style={S.label}>Terminal Font Size</label>
          <div style={S.control}>
            <button
              style={S.stepBtn}
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  terminalFontSize: Math.max(10, s.terminalFontSize - 1),
                }))
              }
            >
              -
            </button>
            <span style={S.value}>{settings.terminalFontSize}px</span>
            <button
              style={S.stepBtn}
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  terminalFontSize: Math.min(32, s.terminalFontSize + 1),
                }))
              }
            >
              +
            </button>
          </div>
        </div>
        <div style={S.row}>
          <label style={S.label}>Default Shell</label>
          <div style={S.control}>
            {['bash', 'zsh'].map((sh) => (
              <button
                key={sh}
                style={{
                  ...S.shellBtn,
                  ...(settings.defaultShell === sh ? S.shellBtnActive : {}),
                }}
                onClick={() => setSettings((s) => ({ ...s, defaultShell: sh }))}
              >
                {sh}
              </button>
            ))}
          </div>
        </div>
        <div style={S.hint}>
          Changes apply to new terminals. Existing terminals keep their current settings.
        </div>

        <div style={S.sectionDivider} />

        <div style={S.sectionHeader}>Workspaces Panel</div>
        <ModeRadioGroup
          label="Display Mode"
          ariaLabel="Workspaces panel display mode"
          options={PANEL_MODES}
          value={workspacesPanelMode}
          onChange={onWorkspacesPanelModeChange}
        />
        <div style={S.hint}>
          Docked pins the panel as a permanent left sidebar. Overlay floats it over the terminal.
          Narrow viewports always use overlay regardless of this setting.
        </div>

        <div style={S.sectionDivider} />

        <div style={S.sectionHeader}>Files Panel</div>
        <ModeRadioGroup
          label="Display Mode"
          ariaLabel="Files panel display mode"
          options={PANEL_MODES}
          value={filesPanelMode}
          onChange={onFilesPanelModeChange}
        />
        <div style={S.hint}>
          Docked pins the panel as a permanent right sidebar (auto-narrows to the file tree when
          no files are open). Overlay floats it over the terminal. Narrow viewports always use
          overlay.
        </div>

        <div style={S.sectionDivider} />

        <div style={S.sectionHeader}>Browser View</div>
        <ModeRadioGroup
          label="Display Mode"
          ariaLabel="Browser view display mode"
          options={PANEL_MODES}
          value={browserPanelMode}
          onChange={onBrowserPanelModeChange}
        />
        <ModeRadioGroup
          label="Inspector"
          ariaLabel="Browser inspector placement"
          options={INSPECTOR_POSITIONS}
          value={browserInspectorPosition}
          onChange={onBrowserInspectorPositionChange}
        />
        <div style={S.hint}>
          Docked shares space with the terminal; overlay floats above it. The inspector can be
          hidden or placed to the right or below the page. Narrow viewports always use the
          full-screen browser view.
        </div>

        <div style={S.sectionDivider} />

        <div style={S.sectionHeader}>Privacy</div>
        <div style={S.row}>
          <label style={S.label}>Telemetry</label>
          <div style={S.control} role="radiogroup" aria-label="Telemetry">
            {(['on', 'off'] as const).map((mode) => {
              const enabled = mode === 'on';
              return (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={settings.telemetryEnabled === enabled}
                  style={{
                    ...S.shellBtn,
                    ...(settings.telemetryEnabled === enabled ? S.shellBtnActive : {}),
                  }}
                  onClick={() => setSettings((s) => ({ ...s, telemetryEnabled: enabled }))}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>
        <div style={S.hint}>
          Pseudonymous usage + performance events. Payloads exclude names, file
          contents, paths, repo names, and plugin identifiers. Turning it off applies immediately;
          turning it on takes effect after a restart. Env{' '}
          <code>DO_NOT_TRACK=1</code> or <code>OMNITERM_TELEMETRY=0</code>{' '}
          overrides this and forces it off.
        </div>
      </div>

      <div style={S.footer}>
        {saveError && <span style={S.errorText}>{saveError}</span>}
        <button style={S.saveBtn} onClick={handleSave} disabled={saving || !loaded}>
          {saving ? 'Saving...' : !loaded ? 'Loading...' : 'Save'}
        </button>
        <button style={S.cancelBtn} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  // Full-height overlay panel, mirroring FilePanel.container so Settings and
  // Files share one visual language. The fixed positioning + shadow live on
  // the wrapper in page.tsx; width is supplied by the caller.
  container: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    borderLeft: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    flexShrink: 0,
  },
  title: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    color: 'var(--text-muted)',
    paddingLeft: '8px',
  },
  body: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  label: {
    fontSize: '13px',
    color: 'var(--text)',
  },
  control: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  stepBtn: {
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '16px',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--bg)',
    cursor: 'pointer',
  },
  value: {
    fontSize: '13px',
    color: 'var(--text-bright)',
    minWidth: '40px',
    textAlign: 'center' as const,
  },
  shellBtn: {
    padding: '4px 14px',
    fontSize: '12px',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'var(--bg)',
    cursor: 'pointer',
  },
  shellBtnActive: {
    color: 'var(--text-bright)',
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  hint: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    lineHeight: '1.4',
  },
  sectionDivider: {
    borderTop: '1px solid var(--border)',
    margin: '16px 0 12px',
  },
  sectionHeader: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    color: 'var(--text-muted)',
    marginBottom: '8px',
    textTransform: 'uppercase' as const,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  errorText: {
    fontSize: '11px',
    color: 'var(--danger, #f85149)',
    marginRight: 'auto',
    lineHeight: '1.3',
  },
  saveBtn: {
    padding: '6px 16px',
    fontSize: '12px',
    background: 'var(--accent)',
    color: 'var(--text-bright)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '6px 16px',
    fontSize: '12px',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    background: 'none',
  },
};
