/**
 * A value encrypted with the new key after an operator confirms the old key is
 * permanently unavailable. It must never be used as a credential.
 */
export const LOST_KEY_ROTATION_SENTINEL = 'SLIDE_CREDENTIAL_ROTATION_REQUIRED:v1';

export function isCredentialRotationRequired(value: string): boolean {
  return value === LOST_KEY_ROTATION_SENTINEL;
}

export class CredentialRotationRequiredError extends Error {
  readonly code = 'CREDENTIAL_ROTATION_REQUIRED';

  constructor() {
    super('CREDENTIAL_ROTATION_REQUIRED：加密密钥已恢复，请重新录入凭据后重试');
    this.name = 'CredentialRotationRequiredError';
  }
}

export function assertCredentialUsable(value: unknown): void {
  if (typeof value === 'string' && isCredentialRotationRequired(value)) {
    throw new CredentialRotationRequiredError();
  }
}
