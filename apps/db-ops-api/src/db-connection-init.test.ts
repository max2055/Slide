import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createPool: vi.fn(),
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: (...args: unknown[]) => state.createPool(...args),
  },
}));

const config = {
  host: '127.0.0.1',
  port: 3308,
  user: 'root',
  password: 'unused',
  database: 'max364_db_init',
};

interface ProbeConnection {
  query: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface ProbePool {
  on: ReturnType<typeof vi.fn>;
  getConnection: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  connection: ProbeConnection;
}

function makePool(options?: {
  getConnection?: () => Promise<ProbeConnection>;
  end?: () => Promise<void>;
  ping?: () => Promise<void>;
  release?: () => void;
}): ProbePool {
  const connection: ProbeConnection = {
    query: vi.fn(async () => [[]]),
    ping: vi.fn(options?.ping ?? (async () => undefined)),
    release: vi.fn(options?.release ?? (() => undefined)),
  };
  const pool: ProbePool = {
    on: vi.fn(),
    getConnection: vi.fn(options?.getConnection ?? (async () => connection)),
    end: vi.fn(options?.end ?? (async () => undefined)),
    execute: vi.fn(async () => [[{ ok: 1 }]]),
    connection,
  };
  return pool;
}

async function loadManager() {
  vi.resetModules();
  const mod = await import('./db-connection.js');
  return mod.dbConnection;
}

describe('database initialization pool lifecycle', () => {
  beforeEach(() => {
    state.createPool.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the pool when getConnection fails and allows a later success to be reused', async () => {
    const failed = makePool({
      getConnection: async () => {
        throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
      },
    });
    const live = makePool();
    state.createPool.mockImplementationOnce(() => failed).mockImplementationOnce(() => live);
    const db = await loadManager();

    expect(await db.initialize(config)).toBe(false);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(db.getPool()).toBeNull();
    expect(db.isConnected()).toBe(false);

    expect(await db.initialize(config)).toBe(true);
    expect(await db.initialize(config)).toBe(true);
    expect(state.createPool).toHaveBeenCalledTimes(2);
    expect(db.getPool()).toBe(live);
    expect(live.end).not.toHaveBeenCalled();
    expect(await db.query('SELECT 1')).toEqual([{ ok: 1 }]);
  });

  it('releases the pool when ping fails and still ends it when release throws', async () => {
    const failed = makePool({
      ping: async () => {
        throw new Error('ping failed');
      },
      release: () => {
        throw new Error('release failed');
      },
    });
    state.createPool.mockImplementation(() => failed);
    const db = await loadManager();

    expect(await db.initialize(config)).toBe(false);
    expect(failed.connection.release).toHaveBeenCalledTimes(1);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(db.getPool()).toBeNull();
    expect(db.isConnected()).toBe(false);
  });

  it('does not keep a pool when release throws after a successful ping', async () => {
    const failed = makePool({
      release: () => {
        throw new Error('release failed');
      },
    });
    const live = makePool();
    state.createPool.mockImplementationOnce(() => failed).mockImplementationOnce(() => live);
    const db = await loadManager();

    expect(await db.initialize(config)).toBe(false);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(await db.initialize(config)).toBe(true);
    expect(db.getPool()).toBe(live);
    expect(live.end).not.toHaveBeenCalled();
  });

  it('clears the failed pool when end throws and then connects', async () => {
    const failed = makePool({
      getConnection: async () => {
        throw new Error('connect failed');
      },
      end: async () => {
        throw new Error('end failed');
      },
    });
    const live = makePool();
    state.createPool.mockImplementationOnce(() => failed).mockImplementationOnce(() => live);
    const db = await loadManager();

    expect(await db.initialize(config)).toBe(false);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(db.getPool()).toBeNull();
    expect(await db.initialize(config)).toBe(true);
    expect(db.getPool()).toBe(live);
  });

  it('returns one result for concurrent initialization and does not leak a second pool', async () => {
    let releaseConnection: (connection: ProbeConnection) => void = () => undefined;
    const pending = new Promise<ProbeConnection>((resolve) => {
      releaseConnection = resolve;
    });
    const live = makePool({ getConnection: () => pending });
    state.createPool.mockImplementation(() => live);
    const db = await loadManager();

    const first = db.initialize(config);
    const second = db.initialize(config);
    expect(state.createPool).toHaveBeenCalledTimes(1);
    releaseConnection(live.connection);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(state.createPool).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();
    expect(db.getPool()).toBe(live);
  });

  it('returns the same failure to concurrent callers and retries once', async () => {
    const failed = makePool({
      getConnection: async () => {
        throw new Error('connect failed');
      },
    });
    const live = makePool();
    state.createPool.mockImplementationOnce(() => failed).mockImplementationOnce(() => live);
    const db = await loadManager();

    await expect(Promise.all([db.initialize(config), db.initialize(config)])).resolves.toEqual([false, false]);
    expect(state.createPool).toHaveBeenCalledTimes(1);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(await db.initialize(config)).toBe(true);
    expect(db.getPool()).toBe(live);
    expect(live.end).not.toHaveBeenCalled();
  });

  it('does not end a pool that belongs to another successful manager', async () => {
    const live = makePool();
    state.createPool.mockImplementationOnce(() => live);
    const healthy = await loadManager();
    expect(await healthy.initialize(config)).toBe(true);

    const failed = makePool({
      getConnection: async () => {
        throw new Error('connect failed');
      },
    });
    state.createPool.mockImplementationOnce(() => failed);
    const other = await loadManager();
    expect(await other.initialize(config)).toBe(false);

    expect(live.end).not.toHaveBeenCalled();
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(healthy.getPool()).toBe(live);
    expect(healthy.isConnected()).toBe(true);
    expect(other.getPool()).toBeNull();
    expect(other.isConnected()).toBe(false);
  });

  it('clears a connected pool when close end throws and allows reconnect', async () => {
    const first = makePool();
    const second = makePool();
    state.createPool.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const db = await loadManager();
    expect(await db.initialize(config)).toBe(true);
    first.end.mockRejectedValueOnce(new Error('end failed'));

    await expect(db.close()).rejects.toThrow('end failed');
    expect(db.getPool()).toBeNull();
    expect(db.isConnected()).toBe(false);
    expect(await db.initialize(config)).toBe(true);
    expect(db.getPool()).toBe(second);
  });
});
