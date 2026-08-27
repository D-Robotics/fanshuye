import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace packages export TypeScript sources for development. Bundle them so
  // the production server never tries to execute those sources with plain Node.
  noExternal: ['@fanshuye/contracts', '@fanshuye/domain'],
});
