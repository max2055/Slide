import fs from 'node:fs';
import { evaluateTokenCalibration } from '../../packages/agent-core/src/__tests__/helpers/token-calibration.js';
const report = evaluateTokenCalibration();
const output = process.argv[2];
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
