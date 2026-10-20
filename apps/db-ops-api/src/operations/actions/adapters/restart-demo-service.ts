import { verify, type KeyObject } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { z } from 'zod';
import {
  createSshHostVerifier,
  normalizeSshHostKeyFingerprint,
} from '../../../security/ssh-host-key.js';
import { OperationsError, operationsContentHash, type ActionPlanVersion } from '../../contracts.js';
import {
  actionConfigHash,
  consumeActionInvocation,
  type ActionAdapter,
  type ActionInvocation,
} from '../executor.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const registrationSchema = z.strictObject({
  protocol: z.literal(1),
  serverId: z.number().int().positive().safe(),
  host: z.literal('192.168.49.130'),
  port: z.literal(22),
  username: z.literal('slide-action'),
  unit: z.literal('slide-action-demo.service'),
  helper: z.literal('/usr/local/libexec/slide-action-demo-helper'),
  helperHash: hash,
  unitHash: hash,
  hostFingerprint: z.string(),
  toolVersion: z.literal('1'),
  eligible: z.literal(true),
});
export type DemoTargetRegistration = z.infer<typeof registrationSchema>;
export interface DemoCredentials {
  privateKey: string | Buffer;
  passphrase?: string;
}
export interface DemoSshClient {
  once(event: string, listener: (...args: any[]) => void): this;
  connect(config: ConnectConfig): this;
  exec(command: string, callback: (error: Error | undefined, stream: any) => void): this;
  end(): this;
}
/** Server composition owns the trusted signing key and credential reference.
 * No client-provided target, SSH settings, command, URL or helper path. */
export class RestartDemoServiceAdapter implements ActionAdapter {
  private readonly target: Readonly<DemoTargetRegistration>;
  private readonly configHash: string;
  constructor(
    registration: unknown,
    signature: Buffer,
    trustedKey: KeyObject,
    private readonly credentials: () => Promise<DemoCredentials>,
    private readonly client: () => DemoSshClient = () => new Client() as unknown as DemoSshClient,
  ) {
    const parsed = registrationSchema.safeParse(registration);
    if (!parsed.success || trustedKey.asymmetricKeyType !== 'ed25519')
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    const configHash = operationsContentHash(parsed.data);
    if (!verify(null, Buffer.from(configHash), trustedKey, signature))
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    normalizeSshHostKeyFingerprint(parsed.data.hostFingerprint);
    this.target = Object.freeze(parsed.data);
    this.configHash = configHash;
  }
  private plan(p: ActionPlanVersion): void {
    if (
      p.content.target.type !== 'server' ||
      p.content.target.id !== this.target.serverId ||
      p.content.tool.name !== 'restart_demo_service' ||
      p.content.tool.version !== this.target.toolVersion ||
      p.content.tool.hash !== this.target.helperHash ||
      p.content.parameters.unit !== this.target.unit ||
      p.content.rollback.capability !== 'none' ||
      actionConfigHash(p) !== this.configHash
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  }
  private async command(
    mode: 'inspect' | 'execute' | 'receipt',
    args: readonly string[] = [],
  ): Promise<unknown> {
    if (
      mode !== 'inspect' &&
      (args.length !== 4 ||
        !/^[a-f0-9-]{36}$/.test(args[0]) ||
        args.slice(1).some((v) => !/^[a-f0-9]{64}$/.test(v)))
    )
      throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const credential = await this.credentials();
    if (!credential.privateKey) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const connection = this.client();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connection.end();
        if (error) reject(new Error('ACTION_TARGET_PROTOCOL_UNAVAILABLE'));
        else resolve(value);
      };
      // A timeout after execute is deliberately indistinguishable from a lost receipt.
      const timer = setTimeout(() => finish(new Error('timeout')), 20_000);
      connection.once('error', () => finish(new Error('ssh')));
      connection.once('close', () => finish(new Error('closed')));
      connection.once('ready', () => {
        connection.exec(
          `sudo -n -- ${this.target.helper} ${mode}${args.length ? ' ' + args.join(' ') : ''}`,
          (error, stream) => {
            if (error) return finish(error);
            let output = '',
              bytes = 0;
            stream.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 16_384) {
                stream.close();
                finish(new Error('oversize'));
              } else output += chunk.toString('utf8');
            });
            stream.stderr.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 16_384) {
                stream.close();
                finish(new Error('oversize'));
              }
            });
            stream.once('error', () => finish(new Error('stream')));
            stream.once('close', (code: number, signal: string) => {
              if (code !== 0 || signal) return finish(new Error('exit'));
              try {
                finish(undefined, JSON.parse(output));
              } catch {
                finish(new Error('json'));
              }
            });
          },
        );
      });
      try {
        connection.connect({
          host: this.target.host,
          port: 22,
          username: this.target.username,
          privateKey: credential.privateKey,
          passphrase: credential.passphrase,
          hostVerifier: createSshHostVerifier(this.target.hostFingerprint),
          readyTimeout: 10_000,
          tryKeyboard: false,
          agentForward: false,
        });
      } catch {
        finish(new Error('connect'));
      }
    });
  }
  async preflight(plan: ActionPlanVersion): Promise<void> {
    this.plan(plan);
    const parsed = z
      .strictObject({
        protocol: z.literal(1),
        configHash: hash,
        helperHash: hash,
        unitHash: hash,
        serverId: z.number().int().positive(),
        unit: z.literal('slide-action-demo.service'),
        invocationId: z.string().regex(/^[a-f0-9]{32}$/),
      })
      .safeParse(await this.command('inspect'));
    if (
      !parsed.success ||
      parsed.data.configHash !== this.configHash ||
      parsed.data.helperHash !== this.target.helperHash ||
      parsed.data.unitHash !== this.target.unitHash ||
      parsed.data.serverId !== this.target.serverId
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
  }
  async execute(invocation: ActionInvocation): Promise<unknown> {
    consumeActionInvocation(invocation);
    if (
      invocation.serverId !== this.target.serverId ||
      invocation.toolHash !== this.target.helperHash ||
      invocation.configHash !== this.configHash
    )
      throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
    return this.command('execute', [
      invocation.operationId,
      invocation.planHash,
      this.configHash,
      this.target.helperHash,
    ]);
  }
  async receipt(plan: ActionPlanVersion, operationId: string): Promise<unknown> {
    this.plan(plan);
    return this.command('receipt', [
      operationId,
      plan.contentHash,
      this.configHash,
      this.target.helperHash,
    ]);
  }
}
