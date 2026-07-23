/**
 * A value encrypted with the new key after an operator confirms the old key is
 * permanently unavailable. It must never be used as a credential.
 */
export const LOST_KEY_ROTATION_SENTINEL = 'SLIDE_CREDENTIAL_ROTATION_REQUIRED:v1';

export function isCredentialRotationRequired(value: string): boolean {
  return value === LOST_KEY_ROTATION_SENTINEL;
}
