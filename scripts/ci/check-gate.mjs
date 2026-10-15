import { validateResults } from './plan.mjs';

validateResults(JSON.parse(process.env.CI_SELECTION), JSON.parse(process.env.CI_NEEDS), !process.argv.includes('--checks-only'));
console.log('All selected CI checks succeeded; unselected checks were skipped as planned.');
