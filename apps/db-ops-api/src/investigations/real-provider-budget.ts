/** Opt-in qualification only. Durable send journal survives schema/process cleanup. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export const T04_AUTHORIZATION = "01a13273-f6cf-759a-ad6d-24bc8ed7e794";
export interface SendRecord {
  authorization: string;
  sequence: number;
  scenario: string;
  at: string;
}

export function stopSends(path: string, reason: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reason)) throw Error("T04_STOP_REASON_INVALID");
  if (existsSync(`${path}.stop`)) return;
  const fd = openSync(`${path}.stop`, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({ authorization: T04_AUTHORIZATION, reason, at: new Date().toISOString() }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readSends(path: string): SendRecord[] {
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    records.some(
      (r, i) =>
        r.authorization !== T04_AUTHORIZATION ||
        r.sequence !== i + 1 ||
        typeof r.scenario !== "string" ||
        !Number.isFinite(Date.parse(r.at)),
    ) ||
    records.length > 6
  )
    throw Error("T04_SEND_JOURNAL_INVALID");
  return records;
}

/** An existing empty journal is an explicit operator initialization, never reset here.
 * Exclusive lock conflicts fail closed. A killed lock holder requires audit, not auto-unlock. */
export function reserveSend(path: string, scenario: string, scenarioLimit: number): SendRecord {
  if (!Number.isSafeInteger(scenarioLimit) || scenarioLimit < 1 || scenarioLimit > 6)
    throw Error("T04_SCENARIO_LIMIT_INVALID");
  const lock = `${path}.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  try {
    if (existsSync(`${path}.stop`)) throw Error("T04_PROVIDER_DIAGNOSIS_REQUIRED");
    const records = readSends(path);
    if (
      records.length >= 6 ||
      records.filter((r) => r.scenario === scenario).length >= scenarioLimit
    )
      throw Error("T04_REAL_REQUEST_LIMIT");
    const record = {
      authorization: T04_AUTHORIZATION,
      sequence: records.length + 1,
      scenario,
      at: new Date().toISOString(),
    };
    const fd = openSync(path, "a");
    try {
      appendFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return record;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
