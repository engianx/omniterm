import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Everything the omniterm server owns. In `vite` dev mode these go to the
// running server (OMNITERM_DEV_SERVER, default http://127.0.0.1:17717) and
// vite serves only the React shell, with HMR. `/t` carries both HTTP and the
// terminal / CDP WebSockets.
const devServer = process.env.OMNITERM_DEV_SERVER ?? 'http://127.0.0.1:17717';
const proxied = ['/api', '/t', '/pdfjs', '/devtools', '/status'];

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
  server: {
    host: process.env.OMNITERM_DEV_HOST ?? '127.0.0.1',
    port: Number(process.env.OMNITERM_DEV_PORT) || 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      proxied.map((prefix) => [prefix, { target: devServer, ws: true, changeOrigin: false }]),
    ),
  },
});
