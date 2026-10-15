import { randomBytes } from "node:crypto";
// Task-owned real service: unchanged production handlers + MySQL + JWT/live RBAC.
// Intentionally does not start any Agent, Provider, worker, binding or collector.
import Fastify from "../../apps/db-ops-api/node_modules/fastify/fastify.js";
import { authDatabaseService } from "../../apps/db-ops-api/src/auth-database-service.js";
import { createVerifyToken } from "../../apps/db-ops-api/src/auth-middleware.js";
import {
  actorContextService,
  applyActorSecuritySchema,
  signAccessToken,
} from "../../apps/db-ops-api/src/auth/actor-context.js";
import { dbConnection } from "../../apps/db-ops-api/src/db-connection.js";
import { registerHealthRoutes } from "../../apps/db-ops-api/src/health-routes.js";
import { installPlatformObservation } from "../../apps/db-ops-api/src/platform/platform-observation-service.js";
import { MysqlWorkflowStore } from "../../apps/db-ops-api/src/workflows/worker-runtime.js";
if (process.env.DB_NAME !== "db_ops_ai_qualification_MAX180")
  throw new Error("MAX180 isolated database required");
if (!(await dbConnection.initialize())) throw new Error("MAX180 database unavailable");
await applyActorSecuritySchema(dbConnection.getPool()!);
const secret = randomBytes(32).toString("hex");
const app = Fastify();
const verifyToken = createVerifyToken(secret, actorContextService);
const store = new MysqlWorkflowStore(() => dbConnection.getPool());
await installPlatformObservation(app, verifyToken, undefined, () => store.observeQueue());
registerHealthRoutes(app, verifyToken, undefined, async () => dbConnection.isConnected());
app.post("/api/auth/login", async (request, reply) => {
  const { username, password } = request.body as { username: string; password: string };
  const user = await authDatabaseService.getUserByUsername(username);
  if (!user || !(await authDatabaseService.verifyPassword(username, password)))
    return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  const actor = await actorContextService.loadActiveActor(user.id);
  return {
    token: signAccessToken(actor, secret),
    user: { id: actor.userId, username: actor.username },
  };
});
app.get(
  "/api/auth/permissions",
  { preHandler: [verifyToken] },
  async (request) => (request as any).user.permissions,
);
process.on("SIGTERM", () => {
  void app
    .close()
    .then(() => dbConnection.close())
    .then(() => process.exit(0));
});
await app.listen({ host: "127.0.0.1", port: 51948 });
