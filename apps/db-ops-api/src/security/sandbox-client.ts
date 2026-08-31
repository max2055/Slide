import { createHmac, randomUUID } from 'node:crypto';

export interface SandboxExecutionRequest {
  runtime: string;
  command: string[];
  networkMode?: 'restricted';
  files?: Array<{ path: string; contentBase64: string }>;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DatabaseNetworkScanRequest {
  cidr: string;
  profile: string;
}

async function parseResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('SANDBOX_RESPONSE_INVALID');
  }
}

export class SandboxClient {
  constructor(
    private readonly baseUrl = process.env.SANDBOX_CONTROLLER_URL || '',
    private readonly secret = process.env.SANDBOX_CONTROLLER_SECRET || '',
  ) {}

  async execute(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<unknown> {
    if (!this.baseUrl.startsWith('http://') || this.secret.length < 32) throw new Error('SANDBOX_CLIENT_NOT_CONFIGURED');
    const body = Buffer.from(JSON.stringify(request));
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = createHmac('sha256', this.secret)
      .update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
    const response = await fetch(new URL('/v1/jobs', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slide-timestamp': timestamp,
        'x-slide-nonce': nonce,
        'x-slide-signature': signature,
      },
      body,
      signal,
    });
    const result = await parseResponse(response);
    if (!response.ok) throw new Error(`SANDBOX_REQUEST_FAILED:${response.status}`);
    return result;
  }

  async scanDatabaseEndpoints(request: DatabaseNetworkScanRequest, signal?: AbortSignal): Promise<unknown> {
    return this.post('/v1/network-scans', request, signal);
  }

  configured(): boolean {
    return this.baseUrl.startsWith('http://') && this.secret.length >= 32;
  }

  async status(signal?: AbortSignal): Promise<unknown> {
    if (!this.configured()) throw new Error('SANDBOX_CLIENT_NOT_CONFIGURED');
    const body = Buffer.alloc(0);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = createHmac('sha256', this.secret)
      .update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
    const response = await fetch(new URL('/v1/status', this.baseUrl), {
      headers: {
        'x-slide-timestamp': timestamp,
        'x-slide-nonce': nonce,
        'x-slide-signature': signature,
      },
      signal,
    });
    const result = await parseResponse(response);
    if (!response.ok) throw new Error(`SANDBOX_STATUS_FAILED:${response.status}`);
    return result;
  }

  private async post(path: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.configured()) throw new Error('SANDBOX_CLIENT_NOT_CONFIGURED');
    const body = Buffer.from(JSON.stringify(request));
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = createHmac('sha256', this.secret)
      .update(timestamp).update('.').update(nonce).update('.').update(body).digest('hex');
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slide-timestamp': timestamp,
        'x-slide-nonce': nonce,
        'x-slide-signature': signature,
      },
      body,
      signal,
    });
    const result = await parseResponse(response);
    if (!response.ok) throw new Error(`SANDBOX_REQUEST_FAILED:${response.status}`);
    return result;
  }
}

export const sandboxClient = new SandboxClient();
