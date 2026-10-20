/** Auxiliary foreground runner used instead of the old per-phase run/common
 * scripts. Imports have no effects; the independently reviewed driver supplies
 * its complete phase list and configuration restoration/connection cleanup. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { bytesHash } from '../../apps/db-ops-api/src/operations/source-package/config.js';
import { runSourceStage } from '../../apps/db-ops-api/src/operations/source-package/stage.js';

export interface SourceStageBinding {
  allocationFile: string; allocationHash: string; allocationId: string; head: string;
  sourceContainerId: string; sourceLabel: string;
}
export interface CurrentSourceStage { databasePort: number; head: string; allocationId: string; expiresAt: string; }

export async function runBoundSourceStage(binding: Readonly<SourceStageBinding>, steps: {
  phases: readonly ((current: CurrentSourceStage) => Promise<unknown>)[];
  restore: () => Promise<void>; close: () => Promise<void>;
}) {
  const b = Object.freeze({ ...binding });
  if (!/^[a-f0-9]{64}$/.test(b.sourceContainerId) || !b.sourceLabel || !/^[a-f0-9]{40}$/.test(b.head)) throw Error('STAGE_BINDING');
  const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
  const owned = () => {
    const [source] = JSON.parse(docker(['inspect', b.sourceContainerId]));
    if (source.Id !== b.sourceContainerId || source.Config.Labels['com.slide.v23.source'] !== b.sourceLabel
      || source.Name === '/mysql3308') throw Error('STAGE_SOURCE_OWNERSHIP');
    return source;
  };
  // Establish ownership before registering any finalizer. A bad binding must
  // never stop a container belonging to another task.
  owned();
  await runSourceStage({
    inspect: async () => {
      const stat = statSync(b.allocationFile);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) throw Error('STAGE_PRIVATE_ALLOCATION');
      const bytes = readFileSync(b.allocationFile), allocation = JSON.parse(bytes.toString());
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (bytesHash(bytes) !== b.allocationHash || allocation.allocationId !== b.allocationId || allocation.head !== b.head
        || head !== b.head || allocation.issue !== 'MAX-203' || allocation.owner !== '45c6e088-9615-48ae-a675-f91d1447c25e'
        || allocation.target !== '192.168.49.130:22/mysql:3308' || !(Date.parse(allocation.expiresAt) > Date.now())) throw Error('STAGE_ALLOCATION');
      const source = owned(), mapping = source.NetworkSettings.Ports['3306/tcp'];
      const databasePort = Number(mapping?.[0]?.HostPort);
      if (!source.State.Running || mapping?.length !== 1 || mapping[0].HostIp !== '127.0.0.1'
        || !Number.isSafeInteger(databasePort) || databasePort < 1024 || [3306,3307,3308].includes(databasePort)) throw Error('STAGE_SOURCE_MAPPING');
      return { databasePort, head, allocationId: b.allocationId, expiresAt: allocation.expiresAt };
    },
    phases: steps.phases, restore: steps.restore, close: steps.close,
    stop: async () => { const source = owned(); if (source.State.Running) docker(['stop', '--time', '15', b.sourceContainerId]); },
  });
}
