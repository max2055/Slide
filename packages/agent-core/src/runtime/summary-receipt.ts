import { createHash } from "node:crypto";
import type { LLMResponse } from "../types.js";
export type SummaryRejection = "provider" | "incomplete" | "tools" | "json" | "schema";
export interface SummaryIdentity {
  id: string;
  purpose: "summary";
  sourceHash: string;
}
export interface SummaryReceipt extends SummaryIdentity {
  responseHash: string;
  status: "accepted" | "rejected";
  reason?: SummaryRejection;
}
// MySQL JSON preserves values and array order, but normalizes object key order.
// Normalize JSON values first so undefined optional fields match SQL readback.
const canonical = (value: any): string =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value !== null && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
          .join(",") +
        "}"
      : JSON.stringify(value);
export const responseHash = (response: unknown) =>
  createHash("sha256")
    .update(canonical(JSON.parse(JSON.stringify(response))))
    .digest("hex");
export function summaryRejection(response: LLMResponse): SummaryRejection | undefined {
  if (response.error || response.errorKind) return "provider";
  if (response.finishReason !== "stop") return "incomplete";
  if (response.hasToolCalls || response.toolCalls.length) return "tools";
  let value: any;
  try {
    value = JSON.parse(response.content ?? "");
  } catch {
    return "json";
  }
  const keys = ["goal", "constraints", "done", "pending", "evidence", "uncertain"];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== keys.length ||
    !keys.every(
      (k) => Array.isArray(value[k]) && value[k].every((s: unknown) => typeof s === "string"),
    ) ||
    !value.goal.length
  )
    return "schema";
}
/** Called inside the fenced checkpoint transaction, after checkpoint storage.
 * A metered response alone is never sufficient acknowledgement. */
export function acknowledgeSummary(provider: any, payload: Record<string, any>): boolean {
  const receipt = payload.context_request_v1 as SummaryReceipt | undefined;
  if (
    !receipt ||
    receipt.purpose !== "summary" ||
    provider?.purpose !== "summary" ||
    receipt.id !== provider.id
  )
    return false;
  if (
    !Number.isSafeInteger(provider.response?.usage?.prompt_tokens) ||
    provider.response.usage.prompt_tokens < 0 ||
    !Number.isSafeInteger(provider.response.usage.completion_tokens) ||
    provider.response.usage.completion_tokens < 0
  )
    return false;
  if (
    provider.status !== "received" ||
    provider.id !== receipt.id ||
    provider.sourceHash !== receipt.sourceHash ||
    !provider.response ||
    responseHash(provider.response) !== receipt.responseHash
  )
    throw Error("INVESTIGATION_PROVIDER_UNKNOWN");
  const reason = summaryRejection(provider.response);
  if (receipt.status === "rejected") {
    if (!reason || receipt.reason !== reason) throw Error("INVESTIGATION_PROVIDER_UNKNOWN");
  } else if (receipt.status === "accepted") {
    if (
      reason ||
      receipt.reason ||
      payload.context_summary_v1?.sourceHash !== receipt.sourceHash ||
      responseHash(payload.context_summary_v1?.summary) !==
        responseHash(JSON.parse(provider.response.content))
    )
      throw Error("INVESTIGATION_PROVIDER_UNKNOWN");
  } else throw Error("INVESTIGATION_PROVIDER_UNKNOWN");
  return true;
}
