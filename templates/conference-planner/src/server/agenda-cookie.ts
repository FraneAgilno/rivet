const SESSION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_SESSION_COUNT = 32;
const MAX_COOKIE_BYTES = 4096;
const VERSION = 'v1';
const encoder = new TextEncoder();

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function requireSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (typeof secret !== 'string' || encoder.encode(secret).byteLength < 32) {
    throw new Error('Agenda cookie signing is not configured.');
  }
  return ownedBytes(encoder.encode(secret));
}

function normalizeSessionIds(sessionIds: readonly string[]): readonly string[] {
  if (!Array.isArray(sessionIds) || sessionIds.length > MAX_SESSION_COUNT) {
    throw new TypeError('Agenda session IDs are invalid.');
  }
  const normalized = [...new Set(sessionIds)];
  if (normalized.some(id => typeof id !== 'string' || id.length > 80 || !SESSION_ID.test(id))) {
    throw new TypeError('Agenda session IDs are invalid.');
  }
  return Object.freeze(normalized.sort());
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return ownedBytes(Buffer.from(value, 'base64url'));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    requireSecret(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function encodeAgendaCookie(
  sessionIds: readonly string[],
  secret: string,
): Promise<string> {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(normalizeSessionIds(sessionIds))));
  const signed = `${VERSION}.${payload}`;
  const signature = encodeBase64Url(new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signed)),
  ));
  const value = `${signed}.${signature}`;
  if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) {
    throw new TypeError('Agenda cookie is too large.');
  }
  return value;
}

export async function decodeAgendaCookie(
  value: string | undefined,
  secret: string,
): Promise<readonly string[]> {
  const key = await hmacKey(secret);
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) return [];
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION
    || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return [];
  const [version, payload, suppliedSignature] = parts;
  try {
    const verified = await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(suppliedSignature),
      encoder.encode(`${version}.${payload}`),
    );
    if (!verified) return [];
    const source = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payload));
    return normalizeSessionIds(JSON.parse(source) as string[]);
  } catch {
    return [];
  }
}
