/**
 * Slide - Main Entry Point
 *
 * Architecture layers:
 * - Core: Gateway protocol, UI lifecycle, state management
 * - Business (slide/): Database operations, LLM integration, alerts
 */
// Core styles
import './app/styles.css';

// Initialize theme system
import { initTheme } from './utils/theme-manager.js';
initTheme();

// Import the main app component
import './app/ui/app.js';
import { authFetch } from './api/index.js';
import { installPlatformRuntimeObservation } from './platform-runtime.js';

const stopRuntimeObservation = installPlatformRuntimeObservation(window,
  body => authFetch('/api/platform/frontend-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  () => Boolean(localStorage.getItem('token')), import.meta.env.VITE_SLIDE_BUILD_ID ?? 'unknown');
import.meta.hot?.dispose(stopRuntimeObservation);
