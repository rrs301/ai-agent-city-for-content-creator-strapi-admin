import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Headquarters scope for MCP memory tools.
 *
 * The Next.js server (the only MCP client) signs a short-lived scope with MEMORY_SCOPE_SECRET and sends it
 * in the `x-creator-city-scope` header. The model never sees or sets this header, so an agent can only
 * read and write memory of the headquarters the server ran it for.
 *
 * Format: `v1.<base64url(JSON)>.<hex HMAC-SHA256 of "v1.<payload>">`
 */
export const SCOPE_HEADER = 'x-creator-city-scope';

export type MemoryScope = {
  /** Headquarters documentId. Required. */
  hq: string;
  /** Agent documentId of the caller, if the caller is a department agent. */
  agent?: string;
  /** Task documentId the caller is working on, if any. */
  task?: string;
  /** Expiry, unix seconds. */
  exp: number;
};

const DOCUMENT_ID = /^[a-z0-9]{8,64}$/i;

export class ScopeError extends Error {}

export function verifyScope(header: string | string[] | undefined, secret: string | undefined): MemoryScope {
  if (!secret || secret.length < 32) throw new ScopeError('Memory is not configured: MEMORY_SCOPE_SECRET is missing or too short.');
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new ScopeError('Missing headquarters scope.');

  const [version, payload, signature] = value.split('.');
  if (version !== 'v1' || !payload || !signature) throw new ScopeError('Malformed headquarters scope.');

  const expected = createHmac('sha256', secret).update(`${version}.${payload}`).digest('hex');
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    throw new ScopeError('Invalid headquarters scope signature.');
  }

  let scope: Partial<MemoryScope>;
  try {
    scope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ScopeError('Malformed headquarters scope.');
  }
  if (typeof scope.hq !== 'string' || !DOCUMENT_ID.test(scope.hq)) throw new ScopeError('Scope has no headquarters.');
  if (scope.agent !== undefined && (typeof scope.agent !== 'string' || !DOCUMENT_ID.test(scope.agent))) throw new ScopeError('Bad agent in scope.');
  if (scope.task !== undefined && (typeof scope.task !== 'string' || !DOCUMENT_ID.test(scope.task))) throw new ScopeError('Bad task in scope.');
  if (typeof scope.exp !== 'number' || scope.exp * 1000 < Date.now()) throw new ScopeError('Headquarters scope has expired.');
  return scope as MemoryScope;
}
