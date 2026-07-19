import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeMicrosoftSmtpRefreshToken } from './smtp-oauth2.js';

describe('Microsoft SMTP OAuth2', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exchanges a refresh token using the Outlook SMTP.Send scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeMicrosoftSmtpRefreshToken({
      tenant: 'consumers', clientId: 'client-id', refreshToken: 'refresh-token',
    })).resolves.toEqual('access-token');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('scope=offline_access+https%3A%2F%2Foutlook.office.com%2FSMTP.Send');
  });
});
