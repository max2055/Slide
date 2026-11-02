import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AlertDependencies } from "./alert-dependencies.js";
import { ActorAuthenticationError } from "./auth/actor-context.js";
import { dbConnection } from "./db-connection.js";
import { PolicyError } from "./metrics/policy/model.js";
export async function registerAlertDependencyRoutes(
  app: FastifyInstance,
  verify: preHandlerHookHandler,
  service = new AlertDependencies(() => {
    const p = dbConnection.getPool();
    if (!p) throw Error("DEPENDENCY_UNAVAILABLE");
    return p;
  }),
) {
  for (const op of ["list", "catalog", "operation", "create", "update"] as const) {
    const url =
      "/api/alerts/dependencies" +
      (op === "catalog"
        ? "/resources"
        : op === "operation"
          ? "/operations/:key"
          : op === "update"
            ? "/:id"
            : "");
    app.route({
      method: op === "create" ? "POST" : op === "update" ? "PUT" : "GET",
      url,
      preHandler: [verify],
      handler: async (req: any, reply) => {
        reply.header("Cache-Control", "private, no-store");
        try {
          if (op === "list") return await service.list(req.user);
          if (op === "catalog") return await service.catalog(req.user);
          if (op === "operation") return await service.operation(req.user, req.params.key);
          return await service.change(req.user, op === "update" ? req.params.id : null, req.body);
        } catch (e) {
          if (e instanceof ActorAuthenticationError)
            return reply.code(401).send({ error: "DEPENDENCY_AUTH" });
          if (e instanceof PolicyError) return reply.code(e.status).send({ error: e.code });
          if (e instanceof z.ZodError) return reply.code(400).send({ error: "DEPENDENCY_INPUT" });
          return reply.code(503).send({ error: "DEPENDENCY_STATE_UNKNOWN" });
        }
      },
    });
  }
}
