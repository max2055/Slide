import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, createWriteStream } from "node:fs";
/** Task-owned full production API + isolated SQL schema. Never binds resources or calls models. */
import { createRequire } from "node:module";
import { createServer as tcpServer } from "node:net";
import { resolve } from "node:path";
import { createServer } from "vite";
const require = createRequire(resolve("../apps/db-ops-api/package.json"));
const mysql = require("mysql2/promise"),
  bcrypt = require("bcrypt"),
  dotenv = require("dotenv");
async function freePort(): Promise<number> {
  const server = tcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
export async function startMax181Server(output: string) {
  const source = process.env.MAX181_DB_ENV;
  if (!source)
    throw new Error("MAX181_DB_ENV must name an authorized local database environment file");
  const parsed = dotenv.parse(readFileSync(source));
  const db = Object.fromEntries(
    ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"].map((k) => [k, process.env[k] ?? parsed[k]]),
  );
  const schema = `slide_max181_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const apiPort = await freePort(),
    wsPort = await freePort();
  const password = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    ...db,
    DB_NAME: schema,
    NODE_ENV: "test",
    JWT_SECRET_KEY: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PORT: String(apiPort),
    AGENT_WS_PORT: String(wsPort),
    AGENT_WS_HOST: "127.0.0.1",
    SLIDE_MEMORY_PIPELINE_ENABLED: "false",
    SLIDE_SYSTEM_INVESTIGATION_ENABLED: "false",
  };
  const apiCwd = resolve("../apps/db-ops-api");
  const log = createWriteStream(resolve(output, "service.log"));
  const run = (file: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: apiCwd, env });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    return child;
  };
  const admin = await mysql.createConnection({
    host: db.DB_HOST,
    port: Number(db.DB_PORT),
    user: db.DB_USER,
    password: db.DB_PASSWORD,
  });
  let api: ReturnType<typeof run> | undefined,
    vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const close = async () => {
    await vite?.close();
    if (api && api.exitCode === null) {
      const ended = once(api, "exit");
      api.kill("SIGTERM");
      await ended;
    }
    if (!/^slide_max181_\d+_[a-f0-9]+$/.test(schema)) throw new Error("unsafe schema");
    await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await admin.end();
    log.end();
  };
  try {
    const init = run("init-db.ts");
    const [code] = await once(init, "exit");
    if (code) throw new Error("schema initialization failed; see service.log");
    await admin.query(`UPDATE \`${schema}\`.llm_providers SET enabled=0,is_default=0`);
    const hash = await bcrypt.hash(password, 10);
    await admin.query(
      `INSERT INTO \`${schema}\`.users (username,password_hash,status) VALUES ('max181-reader',?,'active')`,
      [hash],
    );
    await admin.query(
      `INSERT INTO \`${schema}\`.user_roles (user_id,role_id) SELECT u.id,r.id FROM \`${schema}\`.users u JOIN \`${schema}\`.roles r ON r.name='admin' WHERE u.username='max181-reader'`,
    );
    api = run("server.ts");
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const deadline = Date.now() + 90000;
    while (true) {
      if (api.exitCode !== null) throw new Error("production API stopped; see service.log");
      try {
        if ((await fetch(apiUrl + "/api/health/ready")).ok) break;
      } catch {}
      if (Date.now() > deadline)
        throw new Error("production API readiness timeout; see service.log");
      await new Promise((r) => setTimeout(r, 250));
    }
    vite = await createServer({
      root: resolve("."),
      configFile: resolve("vite.config.js"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: {
          "/api": { target: apiUrl, changeOrigin: true },
          "/__slide": { target: `http://127.0.0.1:${wsPort}` },
          "/agent-ws": { target: `http://127.0.0.1:${wsPort}`, ws: true },
        },
      },
    });
    await vite.listen();
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
    return {
      url,
      apiUrl,
      password,
      close,
      identity: {
        pid: api.pid,
        apiPort,
        wsPort,
        cwd: apiCwd,
        command: "node --import tsx server.ts",
        schema,
        log: "service.log",
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
