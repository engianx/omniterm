import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Builds the agent's SPA into dist/client/. The plugin's Express router serves
// that bundle: index.html per instance at `/agent/:id/`, and the static assets
// at the shared `/agent-assets/` prefix.
//
// `base: "/agent-assets/"` makes the built index.html reference its JS/CSS at an
// ABSOLUTE, host-rooted `/agent-assets/...` path. That keeps asset URLs stable
// regardless of which `/agent/:id/` instance loaded the HTML, while the SPA's
// own API calls stay RELATIVE (`api/...`) so they resolve under `/agent/:id/`.
export default defineConfig({
  plugins: [react()],
  base: '/agent-assets/',
  root: path.resolve(__dirname, 'client'),
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
});
