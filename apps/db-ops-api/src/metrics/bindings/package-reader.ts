/**
 * MAX-238 / B2F — the shared fence every legacy single-package reader uses.
 *
 * A stored `metric_policy_bindings.payload` is either the accepted single-package
 * `Published` value (no envelope or explicit `package-v1`) or the template
 * `templates-v1` envelope. Only the accepted codec may decide which one it is;
 * no reader may cast a row straight to `Published`. Legacy readers call
 * `readLegacyPublished` and get either the validated legacy value or a stable
 * error: a template row, an unknown envelope, an ambiguous source and a corrupt
 * snapshot all fail closed, never as "unbound", "not found" or healthy.
 */
import { BindingPersistenceError, decodeBindingPayload, type DecodedLegacyBindingPayload, type DecodedTemplateBindingPayload } from './persistence-codec.js';
import type { Published } from '../policy/model.js';

/** Stable code the single-package path uses when a template row is encountered. */
export const TEMPLATE_BINDING_UNSUPPORTED = 'TEMPLATE_BINDING_UNSUPPORTED';

export class TemplateBindingUnsupportedError extends Error {
  readonly code = TEMPLATE_BINDING_UNSUPPORTED;
  constructor() {
    super(TEMPLATE_BINDING_UNSUPPORTED);
    this.name = 'TemplateBindingUnsupportedError';
  }
}

export type StoredBindingRead =
  | { source: 'package'; published: Published }
  | { source: 'template'; template: DecodedTemplateBindingPayload };

/**
 * The exact stored value of a validated legacy row. The codec has already proved
 * the envelope/source, the binding, the application state and that `resolved`
 * belongs to this row's resource and revision, so this is the same `Published`
 * value the legacy writer produced — `package-v1` only adds the carrier.
 */
const publishedOf = (decoded: DecodedLegacyBindingPayload): Published =>
  decoded.payload as unknown as Published;

/** Which form a row is; a template row is reported, never decoded as Published. */
export function readStoredBinding(raw: string | unknown): StoredBindingRead {
  const decoded = decodeBindingPayload(raw);
  // A template row is handed back as its decoded envelope so the template
  // runtime can execute the exact pending plan; the legacy single-package
  // readers still see only the `source` discriminant and keep refusing it.
  if (decoded.kind === 'template_pending') return { source: 'template', template: decoded };
  return { source: 'package', published: publishedOf(decoded) };
}

/**
 * Read a row on the legacy path. A template row has a fixed internal error; the
 * policy boundary maps it to `PolicyError`, every other reader keeps the message
 * as its stable code. Codec failures keep their own stable codes and never echo
 * the payload, parameters or a driver message.
 */
export function readLegacyPublished(raw: string | unknown): Published {
  const stored = readStoredBinding(raw);
  if (stored.source === 'template') throw new TemplateBindingUnsupportedError();
  return stored.published;
}

/** True only for the stable "this row is a template" rejection. */
export const isTemplateBindingUnsupported = (error: unknown): error is TemplateBindingUnsupportedError =>
  error instanceof TemplateBindingUnsupportedError;

/** The stable diagnostic code for a refused row; `null` means it is not a read failure. */
export function bindingReadCode(error: unknown): string | null {
  if (error instanceof TemplateBindingUnsupportedError) return error.code;
  if (error instanceof BindingPersistenceError) return error.code;
  return null;
}
