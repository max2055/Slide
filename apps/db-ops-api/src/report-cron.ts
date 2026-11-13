import { CronTime } from 'cron';

export class InvalidReportCronError extends Error {
  constructor() { super('报表 cron 表达式无效'); this.name = 'InvalidReportCronError'; }
}

/** Use the scheduler's parser, including five/six fields, aliases and presets. */
export function assertReportCron(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidReportCronError();
  try { new CronTime(value); }
  catch { throw new InvalidReportCronError(); }
}
