import { mergeConfig, defineConfig } from 'vite';
import base from './vite.config.js';
// Performance traces must not be invalidated by HMR or evidence-file writes.
export default mergeConfig(base, defineConfig({ server: { hmr: false, watch: null } }));
