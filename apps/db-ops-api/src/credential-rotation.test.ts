import { describe, expect, it } from 'vitest';
import { LOST_KEY_ROTATION_SENTINEL, isCredentialRotationRequired } from './credential-rotation.js';

describe('lost encryption-key rotation marker', () => {
  it('is an exact sentinel that cannot be mistaken for a normal credential', () => {
    expect(LOST_KEY_ROTATION_SENTINEL).toMatch(/^SLIDE_CREDENTIAL_ROTATION_REQUIRED:/);
    expect(isCredentialRotationRequired(LOST_KEY_ROTATION_SENTINEL)).toBe(true);
    expect(isCredentialRotationRequired('')).toBe(false);
    expect(isCredentialRotationRequired('SLIDE_CREDENTIAL_ROTATION_REQUIRED:other')).toBe(false);
  });
});
