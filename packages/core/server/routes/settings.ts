import { Router } from 'express';
import { loadSettings, saveSettings } from '../../lib/settings.js';
import { watchWorkspace, stopWatching } from '../../lib/watcher.js';

export const settingsRouter: Router = Router();

settingsRouter.get('/settings', (_req, res) => {
  res.json(loadSettings());
});

settingsRouter.put('/settings', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const updated = saveSettings(body);

  if (updated.activePath) {
    watchWorkspace(updated.activePath);
  } else {
    stopWatching();
  }

  res.json(updated);
});
