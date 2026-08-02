import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Builds the React shell into `dist/client/`. The server's static-file
// handler serves index.html + assets from there.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'client'),
  publicDir: path.resolve(__dirname, 'public'),
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
});
