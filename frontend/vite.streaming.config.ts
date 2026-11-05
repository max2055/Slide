import { mergeConfig, defineConfig } from 'vite';
import base from './vite.config.js';

// mergeConfig skips null overrides, so watch:null must be set on a new server object.
// Performance traces must not be invalidated by file watching or evidence-file writes.
const merged = mergeConfig(base, defineConfig({ server: { hmr: false } }));
export default {
  ...merged,
  server: { ...merged.server, hmr: false, watch: null },
};
