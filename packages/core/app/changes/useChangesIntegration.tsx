'use client';

/**
 * Git changes as a sidebar section. Contributes the "Changes" panel only
 * while the active workspace is inside a git work tree; its badge is the
 * number of changed files.
 */

import type { PluginIntegration } from '../types';
import { changeCount } from './changeRows';
import ChangesPanel from './ChangesPanel';
import { useGitState } from './gitStore';
import { SourceControlIcon } from './icons';

export const CHANGES_SECTION = 'changes';

export function useChangesIntegration(args: { activePath: string | null }): { integration: PluginIntegration } {
  const { activePath } = args;
  const { info, changes } = useGitState(activePath);
  if (!activePath || !info?.isRepo) return { integration: {} };
  return {
    integration: {
      sidebarPanels: [
        {
          id: CHANGES_SECTION,
          label: 'Changes',
          icon: <SourceControlIcon size={16} />,
          badge: changeCount(changes),
          render: ({ isMobile, closeSidebar }) => (
            <ChangesPanel
              key={activePath}
              cwd={activePath}
              changes={changes}
              isMobile={isMobile}
              closeSidebar={closeSidebar}
            />
          ),
        },
      ],
    },
  };
}
