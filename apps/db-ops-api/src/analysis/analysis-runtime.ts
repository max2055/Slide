import { dbConnection } from '../db-connection.js';
import { AnalysisDispatchStore } from './analysis-dispatch-store.js';

export const analysisDispatchStore = new AnalysisDispatchStore(() => dbConnection.getPool());
