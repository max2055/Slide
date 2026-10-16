import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Server, Client as RealClient, utils } from 'ssh2';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { operationsContentHash, type ActionPlanVersion } from '../../contracts.js';
import { RestartDemoServiceAdapter, type DemoTargetRegistration } from './restart-demo-service.js';
import { consumeActionInvocation, checkedActionReceipt, actionConfigHash } from '../executor.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const hostKey = Buffer.from('registered-host-key');
const registration: DemoTargetRegistration = {
  protocol: 1,
  serverId: 7,
  host: '192.168.49.130',
  port: 22,
  username: 'slide-action',
  unit: 'slide-action-demo.service',
  helper: '/usr/local/libexec/slide-action-demo-helper',
  helperHash: 'a'.repeat(64),
  unitHash: 'b'.repeat(64),
  hostFingerprint:
    'SHA256:' + createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, ''),
  toolVersion: '1',
  eligible: true,
};
const hash = operationsContentHash(registration),
  signature = sign(null, Buffer.from(hash), privateKey);
const plan = {
  id: randomUUID(),
  version: 1,
  schemaVersion: 1,
  contentHash: 'c'.repeat(64),
  state: 'approved',
  content: {
    target: { type: 'server', id: 7 },
    tool: { name: 'restart_demo_service', version: '1', hash: registration.helperHash },
    parameters: { unit: 'slide-action-demo.service' },
    preconditions: [{ kind: 'target_config_hash', expected: hash }],
    rollback: { capability: 'none' },
  },
} as ActionPlanVersion;
class Client extends EventEmitter {
  config: any;
  commands: string[] = [];
  closed = false;
  response: unknown = {
    protocol: 1,
    configHash: hash,
    helperHash: registration.helperHash,
    unitHash: registration.unitHash,
    serverId: 7,
    unit: registration.unit,
    invocationId: '1'.repeat(32),
  };
  connect(config: any) {
    this.config = config;
    queueMicrotask(() => this.emit('ready'));
    return this;
  }
  exec(command: string, cb: any) {
    this.commands.push(command);
    const stream = new EventEmitter() as any;
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    cb(undefined, stream);
    queueMicrotask(() => {
      stream.emit('data', Buffer.from(JSON.stringify(this.response)));
      stream.emit('close', 0, null);
    });
    return this;
  }
  end() {
    this.closed = true;
    return this;
  }
}
const setup = (c = new Client()) => ({
  c,
  adapter: new RestartDemoServiceAdapter(
    registration,
    signature,
    publicKey,
    async () => ({ privateKey: 'test-key' }),
    () => c,
  ),
});
describe('P07 fixed demo SSH protocol; no real targets', () => {
  it('pins signed immutable target, nonroot account and strict host verification', async () => {
    const { c, adapter } = setup();
    await adapter.preflight(plan);
    expect(c.config).toMatchObject({
      host: '192.168.49.130',
      port: 22,
      username: 'slide-action',
      tryKeyboard: false,
      agentForward: false,
    });
    expect(c.config.hostVerifier(hostKey)).toBe(true);
    expect(c.config.hostVerifier(Buffer.from('mitm'))).toBe(false);
    expect(c.commands).toEqual(['sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect']);
    expect(c.closed).toBe(true);
  });
  it.each([
    'host',
    'username',
    'helper',
    'unit',
    'eligible',
    'serverId',
    'helperHash',
    'unitHash',
  ] as const)('rejects changed signed %s', (key) => {
    const changed = {
      ...registration,
      [key]: key === 'serverId' ? 8 : key === 'eligible' ? false : 'substitution',
    };
    expect(
      () =>
        new RestartDemoServiceAdapter(changed, signature, publicKey, async () => ({
          privateKey: 'key',
        })),
    ).toThrow();
  });
  it('rejects a different signer even with a structurally valid target', () => {
    const attacker = generateKeyPairSync('ed25519');
    expect(
      () =>
        new RestartDemoServiceAdapter(
          registration,
          sign(null, Buffer.from(hash), attacker.privateKey),
          publicKey,
          async () => ({ privateKey: 'key' }),
        ),
    ).toThrow();
  });
  it.each(['server', 'tool', 'config', 'unit', 'rollback'])(
    'rejects plan %s substitution before SSH',
    async (kind) => {
      const { c, adapter } = setup();
      const p = structuredClone(plan);
      if (kind === 'server') p.content.target.id = 8;
      if (kind === 'tool') p.content.tool.hash = 'f'.repeat(64);
      if (kind === 'config') p.content.preconditions[0].expected = 'f'.repeat(64);
      if (kind === 'unit') (p.content.parameters as any).unit = 'sshd.service';
      if (kind === 'rollback') (p.content.rollback as any).capability = 'restart';
      await expect(adapter.preflight(p)).rejects.toThrow();
      expect(c.commands).toHaveLength(0);
    },
  );
  it('rejects wrong helper/config/unit identity in read-only preflight', async () => {
    const { c, adapter } = setup();
    c.response = { ...(c.response as any), helperHash: 'f'.repeat(64) };
    await expect(adapter.preflight(plan)).rejects.toThrow();
  });
  it('plain JSON, Chat token, copied plan and direct calls cannot mint an action capability', async () => {
    const { c, adapter } = setup();
    for (const candidate of [
      { approvalToken: 'general' },
      structuredClone(plan),
      {
        executionId: randomUUID(),
        operationId: randomUUID(),
        planHash: plan.contentHash,
        serverId: 7,
        toolHash: registration.helperHash,
        configHash: hash,
      },
    ]) {
      expect(() => consumeActionInvocation(candidate)).toThrow();
      await expect(adapter.execute(candidate as any)).rejects.toThrow();
    }
    expect(c.commands).toHaveLength(0);
  });
  it('read-only receipt binds original operation and accepts no shell/path/host replacement', async () => {
    const { c, adapter } = setup();
    c.response = null;
    const op = randomUUID();
    expect(await adapter.receipt(plan, op)).toBeNull();
    expect(c.commands).toEqual([
      `sudo -n -- /usr/local/libexec/slide-action-demo-helper receipt ${op} ${plan.contentHash} ${hash} ${registration.helperHash}`,
    ]);
    await expect(adapter.receipt(plan, '../../etc/passwd')).rejects.toThrow();
    await expect(adapter.receipt(plan, '$(reboot)')).rejects.toThrow();
    expect(c.commands).toHaveLength(1);
  });
  it.each(['operationId', 'planHash', 'helperHash', 'configHash', 'unit', 'before', 'outcome'])(
    'rejects untrusted receipt %s',
    (key) => {
      const e = { operationId: randomUUID() } as any;
      const r = {
        protocol: 1,
        operationId: e.operationId,
        planHash: plan.contentHash,
        helperHash: registration.helperHash,
        configHash: hash,
        unit: registration.unit,
        outcome: 'succeeded',
        before: '1'.repeat(32),
        after: '2'.repeat(32),
      };
      expect(() => checkedActionReceipt({ ...r, [key]: 'wrong' }, e, plan)).toThrow();
      expect(checkedActionReceipt(r, e, plan)).toEqual(r);
      expect(() => checkedActionReceipt({ ...r, after: r.before }, e, plan)).toThrow();
    },
  );
  it('requires exactly the registered config precondition', () => {
    expect(actionConfigHash(plan)).toBe(hash);
    expect(() =>
      actionConfigHash({ ...plan, content: { ...plan.content, preconditions: [] } }),
    ).toThrow();
  });
  it('helper rejects malformed protocol before filesystem/service operations', () => {
    const path = new URL(
      '../../../../../../scripts/qualification/action-demo-helper.sh',
      import.meta.url,
    );
    for (const args of [
      [],
      ['execute', '../../x'],
      ['execute', randomUUID(), '$(reboot)', 'x', 'x'],
      ['restart', 'sshd.service'],
    ]) {
      const r = spawnSync('/bin/sh', [path.pathname, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe('ACTION_HELPER_REFUSED_OR_UNAVAILABLE');
    }
    const text = readFileSync(path, 'utf8');
    const python = text.split("<<'PY'\n")[1].split('\nPY')[0];
    const compiled = spawnSync(
      '/usr/bin/python3',
      ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'],
      { input: python, encoding: 'utf8' },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
  });
  it('helper persists actual disk intent; duplicate/crash/receipt-loss never repeats restart', () => {
    const helper = new URL(
      '../../../../../../scripts/qualification/action-demo-helper.sh',
      import.meta.url,
    );
    const python = readFileSync(helper, 'utf8').split("<<'PY'\n")[1].split('\nPY')[0];
    const definitions = python.split('\ntry:\n    main()')[0];
    const harness = `
import tempfile, pathlib, contextlib, io
ns={}
exec(${JSON.stringify(definitions)},ns)
with tempfile.TemporaryDirectory() as directory:
    ns['STATE']=directory
    ns['check_path']=lambda *args: None  # Test fixture only; production fixed-path guard unchanged.
    ns['configuration']=lambda: ({'helperHash':'a'*64},'c'*64)
    ns['os'].geteuid=lambda: 0
    real_fstat=ns['os'].fstat
    def fixture_fstat(fd):
        values=list(real_fstat(fd)); values[4]=0
        return ns['os'].stat_result(values)
    ns['os'].fstat=fixture_fstat
    ns['os'].environ['SUDO_USER']='slide-action'
    counter=[0]
    fault=[False]
    def ctl(*args):
        if args[0]=='restart':
            counter[0]+=1
            if fault[0]: raise TimeoutError('reply lost after restart')
        if args[0]=='is-active': return 'active'
        if args[0]=='show': return ('1' if counter[0]==0 else '2')*32
        return ''
    ns['ctl']=ctl
    def call(mode,op,plan='b'*64):
        ns['sys'].argv=['helper',mode,op,plan,'c'*64,'a'*64]
        out=io.StringIO()
        with contextlib.redirect_stdout(out): ns['main']()
        return ns['json'].loads(out.getvalue())
    op='11111111-1111-4111-8111-111111111111'
    r=call('execute',op)
    assert r['outcome']=='succeeded' and counter[0]==1
    assert call('execute',op)==r and counter[0]==1
    assert call('receipt',op)==r and counter[0]==1
    try: call('execute',op,'f'*64); raise AssertionError('collision accepted')
    except ValueError: pass
    fault[0]=True
    op2='22222222-2222-4222-8222-222222222222'
    unknown=call('execute',op2)
    assert unknown['outcome']=='outcome_unknown' and counter[0]==2
    assert call('execute',op2)==unknown and counter[0]==2
    assert call('receipt',op2)==unknown
    assert pathlib.Path(directory,op2+'.json').exists()
    try: call('execute','33333333-3333-4333-8333-333333333333'); raise AssertionError('unknown bypass')
    except ValueError: pass
    assert counter[0]==2
print('disk intent, duplicate, collision, lost reply, unknown blockade passed')
`;
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', harness], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unknown blockade passed');
  });

  it('real loopback SSH handshake accepts only pinned key and fixed helper command', async () => {
    const host = utils.generateKeyPairSync('ed25519'),
      login = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(host.private);
    if (parsed instanceof Error) throw parsed;
    const fingerprint =
      'SHA256:' +
      createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
    const target = { ...registration, hostFingerprint: fingerprint };
    const targetHash = operationsContentHash(target);
    const targetSignature = sign(null, Buffer.from(targetHash), privateKey),
      commands: string[] = [];
    const server = new Server({ hostKeys: [host.private] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.username === 'slide-action' && ctx.method === 'publickey') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (accept, _reject, info) => {
            commands.push(info.command);
            const channel = accept();
            channel.write(
              JSON.stringify({
                protocol: 1,
                configHash: targetHash,
                helperHash: target.helperHash,
                unitHash: target.unitHash,
                serverId: 7,
                unit: target.unit,
                invocationId: '1'.repeat(32),
              }),
            );
            channel.exit(0);
            channel.end();
          });
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address');
    const localClient = () => {
      const c = new RealClient(),
        connect = c.connect.bind(c);
      // Test-only socket routing. The production adapter supplies its fixed
      // host/account and actual strict verifier to ssh2 unchanged.
      c.connect = (config) => connect({ ...config, host: '127.0.0.1', port: address.port });
      return c as any;
    };
    try {
      const p = structuredClone(plan);
      p.content.preconditions[0].expected = targetHash;
      const a = new RestartDemoServiceAdapter(
        target,
        targetSignature,
        publicKey,
        async () => ({ privateKey: login.private }),
        localClient,
      );
      await a.preflight(p);
      expect(commands).toEqual(['sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect']);
      const wrong = { ...target, hostFingerprint: registration.hostFingerprint },
        wrongHash = operationsContentHash(wrong);
      const b = new RestartDemoServiceAdapter(
        wrong,
        sign(null, Buffer.from(wrongHash), privateKey),
        publicKey,
        async () => ({ privateKey: login.private }),
        localClient,
      );
      p.content.preconditions[0].expected = wrongHash;
      await expect(b.preflight(p)).rejects.toThrow('ACTION_TARGET_PROTOCOL_UNAVAILABLE');
      expect(commands).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
