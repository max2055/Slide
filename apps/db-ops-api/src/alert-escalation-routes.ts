import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { alertEscalationService } from "./alert-escalation-service.js";
export async function registerAlertEscalationRoute(
  app: FastifyInstance,
  verify: preHandlerHookHandler,
) {
  app.post("/api/alerts/:id/escalate", { preHandler: [verify] }, async (req: any, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = z
      .strictObject({ new_level: z.enum(["warning", "error", "critical", "p0"]) })
      .safeParse(req.body);
    const id = Number(req.params.id);
    if (!parsed.success || !Number.isSafeInteger(id) || id <= 0)
      return reply.code(400).send({ error: "ESCALATION_INPUT" });
    const result = await alertEscalationService.manualEscalation(
      id,
      parsed.data.new_level,
      req.user,
    );
    if (!result.success)
      return reply
        .code(
          result.error === "ESCALATION_AUTH" ? 401 : result.error === "ESCALATION_FORBIDDEN"
            ? 403
            : result.error === "ESCALATION_NOT_FOUND"
              ? 404
              : result.error === "ESCALATION_LEVEL" || result.error === "ESCALATION_DIRECTION"
                ? 409
                : 503,
        )
        .send({ error: result.error });
    return result;
  });
}
