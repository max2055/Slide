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
