import type { WorkspacePanelState } from '../lib/settings';

export type WorkspacePanelStates = Record<string, WorkspacePanelState>;
export type ResolvedWorkspacePanelState = {
  browserOpen: boolean;
  filesOpen: boolean;
};

type PanelStateKey = keyof ResolvedWorkspacePanelState;
type BooleanUpdate = boolean | ((previous: boolean) => boolean);

export function resolveWorkspacePanelState(
  states: WorkspacePanelStates,
  activePath: string | null,
  isMobile: boolean,
): ResolvedWorkspacePanelState {
  if (!activePath) return { browserOpen: false, filesOpen: false };
  const saved = states[activePath];
  return {
    browserOpen: saved?.browserOpen ?? !isMobile,
    filesOpen: saved?.filesOpen ?? false,
  };
}

export function updateWorkspacePanelState(
  states: WorkspacePanelStates,
  activePath: string | null,
  key: PanelStateKey,
  update: BooleanUpdate,
  isMobile: boolean,
): WorkspacePanelStates {
  if (!activePath) return states;
  const saved = states[activePath] ?? { browserOpen: null, filesOpen: false };
  const resolved = resolveWorkspacePanelState(states, activePath, isMobile);
  const previous = resolved[key];
  const next = typeof update === 'function' ? update(previous) : update;
  return {
    ...states,
    [activePath]: { ...saved, [key]: next },
  };
}
