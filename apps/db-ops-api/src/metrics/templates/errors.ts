/**
 * MAX-237 / T1 internal template domain — typed failure codes.
 *
 * These codes are the machine-readable part of every rejection. Display text is
 * never the decision input, and none of these codes is registered as a public
 * API error yet: this module is not mounted on a route or process.
 */
export const TEMPLATE_ERROR_STATUS = {
  TEMPLATE_INVALID_INPUT: 400,
  TEMPLATE_FORBIDDEN: 403,
  TEMPLATE_NOT_FOUND: 404,
  TEMPLATE_EXISTS: 409,
  TEMPLATE_DRAFT_CONFLICT: 409,
  TEMPLATE_REVISION_CONFLICT: 409,
  TEMPLATE_VERSION_IMMUTABLE: 409,
  TEMPLATE_NAME_EMPTY: 422,
  TEMPLATE_DRAFT_IDENTITY: 422,
  TEMPLATE_EMPTY: 422,
  TEMPLATE_BASE_INHERITANCE_UNAVAILABLE: 422,
  TEMPLATE_INVALID_PERIOD: 422,
  TEMPLATE_ITEM_CADENCE: 422,
  TEMPLATE_PARAMETER_UNDECLARED: 422,
  TEMPLATE_PARAMETER_INVALID: 422,
  TEMPLATE_ITEM_NOT_FOUND: 422,
  TEMPLATE_ITEM_DUPLICATE: 422,
  TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE: 422,
  TEMPLATE_METRIC_DUPLICATE: 422,
  TEMPLATE_PIN_NOT_FOUND: 422,
  TEMPLATE_MAPPING_MISSING: 422,
  TEMPLATE_MAPPING_AMBIGUOUS: 422,
  TEMPLATE_UNIT_MISMATCH: 422,
  TEMPLATE_DIMENSIONS_MISMATCH: 422,
  TEMPLATE_METRIC_UNKNOWN: 422,
  TEMPLATE_METRIC_DEPRECATED: 422,
  TEMPLATE_METRIC_NOT_COLLECTABLE: 422,
  TEMPLATE_RESOURCE_TYPE_MISMATCH: 422,
  TEMPLATE_CAPABILITY_UNAVAILABLE: 422,
} as const;

export type TemplateErrorCode = keyof typeof TEMPLATE_ERROR_STATUS;

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly status: number;

  constructor(code: TemplateErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TemplateError';
    this.code = code;
    this.status = TEMPLATE_ERROR_STATUS[code];
  }
}

export function requireTemplate(value: unknown, code: TemplateErrorCode, message?: string): asserts value {
  if (!value) throw new TemplateError(code, message);
}
