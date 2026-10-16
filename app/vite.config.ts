import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { themeBootScript } from './src/design/themeBoot';

const isDemoMode = process.env.VITE_ENV === 'demo';

const DEMO_DESCRIPTION = 'Try Nightstand, local control for Eight Sleep Pods, with sample data in your browser. '
  + 'Nothing here connects to a real Pod.';

// Link previews and search results describe the hosted demo as one, not as a Pod's own app.
const demoMeta = (): Plugin => ({
  name: 'demo-meta',
  transformIndexHtml: () => (isDemoMode ? [
    { tag: 'meta', attrs: { name: 'description', content: DEMO_DESCRIPTION }, injectTo: 'head' as const },
    { tag: 'meta', attrs: { property: 'og:title', content: 'Nightstand demo' }, injectTo: 'head' as const },
    { tag: 'meta', attrs: { property: 'og:description', content: DEMO_DESCRIPTION }, injectTo: 'head' as const },
    {
      tag: 'meta',
      attrs: { property: 'og:image', content: 'https://raw.githubusercontent.com/LTimothy/nightstand/main/docs/social-preview.png' },
      injectTo: 'head' as const,
    },
  ] : []),
});

// Sets the stored look on <html> before the first paint, so the page never flashes another one.
const themeBoot = (): Plugin => ({
  name: 'theme-boot',
  transformIndexHtml: () => [{ tag: 'script', children: themeBootScript(), injectTo: 'head' as const }],
});

export default defineConfig({
  plugins: [react(), tsconfigPaths(), demoMeta(), themeBoot()],
  // The app imports the server's schemas; one copy of each shared package,
  // so moment.tz.setDefault reaches the server code too.
  resolve: { dedupe: ['zod', 'moment', 'moment-timezone'] },
  server: {
    fs: { allow: [
      searchForWorkspaceRoot(process.cwd()),
      fileURLToPath(new URL('../LICENSE.md', import.meta.url)),
      `${fileURLToPath(new URL('../LICENSE.md', import.meta.url))}?raw`,
      fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)),
      `${fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))}?raw`,
    ] },
    host: '0.0.0.0', // This makes the server accessible to other devices on the network
    port: 5173, // Optional: specify a port if you want something other than the default
  },
  build: {
    sourcemap: !isDemoMode,
    outDir: isDemoMode ? './dist/' : '../server/public/',
    rollupOptions: {
      output: {
        entryFileNames: 'index.js', // Set the name for the JS entry file
        chunkFileNames: '[name]-[hash].js', // Names for dynamic imports
        assetFileNames: ({ name }) => {
          if (name?.endsWith('.css')) {
            return 'index.css';
          }
          return '[name]-[hash].[ext]';
        },
      },
    },
  },
});
