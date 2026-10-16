import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OperationsError, operationsContentHash } from '../contracts.js';

export const searchInputSchema = z.strictObject({
  state: z.enum(['draft', 'pending_review', 'published', 'expired', 'withdrawn']).default('published'),
  query: z.string().trim().max(200).default(''),
  faultType: z.string().trim().min(1).max(100).optional(),
  resourceType: z.enum(['instance', 'server', 'network_device']).optional(),
  productVersion: z.string().trim().min(1).max(128).optional(),
  resourceVersion: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(2048).optional(),
});
export type CaseSearchInput = z.input<typeof searchInputSchema>;
export type CaseSearch = z.output<typeof searchInputSchema>;

/** Portable index, no optional MySQL parser. Bigram queries do not become an
 * OR of common Chinese characters. Unigrams support single-character queries. */
export function caseTokens(text: string, query = false): string[] {
  const tokens = new Set<string>();
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}+$/u.test(word)) {
      const characters = [...word];
      if (!query || characters.length === 1) for (const c of characters) tokens.add(c);
      for (let i = 0; i + 1 < characters.length; i++) tokens.add(characters[i] + characters[i + 1]);
    } else if (Buffer.byteLength(word) <= 192) tokens.add(word);
    if (tokens.size > (query ? 80 : 4096)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  }
  return [...tokens].sort();
}

const cursorSchema = z.strictObject({ after: z.string().uuid(), asOf: z.iso.datetime({ precision: 3 }),
  filter: z.string().length(64), authority: z.string().length(64), expires: z.number().int() });
export type SearchPosition = z.infer<typeof cursorSchema>;
/** Encrypt keyset identity as well as authenticating it: cursors reveal no
 * hidden/global ordinal, resource identifier or permission snapshot. */
export class CaseCursorCodec {
  private readonly key: Buffer;
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('KNOWLEDGE_CURSOR_KEY_INVALID');
    this.key = Buffer.from(key);
  }
  encode(position: SearchPosition): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(position)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  decode(cursor: string, filter: string, authority: string, now: number): SearchPosition {
    try {
      if (!/^[A-Za-z0-9_-]{40,2048}$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed = cursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
      if (parsed.filter !== filter || parsed.authority !== authority || parsed.expires <= now || Date.parse(parsed.asOf) > now) throw new Error();
      return parsed;
    } catch { throw new OperationsError('OPERATIONS_INPUT_INVALID'); }
  }
}
export const searchFingerprint = ({ cursor: _cursor, ...input }: CaseSearch) => operationsContentHash(input);
